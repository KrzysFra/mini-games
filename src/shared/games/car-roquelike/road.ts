import { ROAD_WIDTH } from "./constants.js";

/**
 * The randomly generated, endless road: a chain of straights and corners. It starts at the origin
 * heading north (the first piece is a fixed straight, where the cars spawn) and may then go any way.
 *
 * The road is one fixed, endless sequence of pieces per seed, so the server and every client get
 * exactly the same road however far, and whenever, each of them has generated it:
 * - it is generated as needed (`ensureRoad`), at least `ROAD_AHEAD` beyond the leading car;
 * - road more than `ROAD_KEEP_BEHIND` behind the destruction front is deleted (the ground under it
 *   is restored, see destruction.ts), and its data is dropped a while later (`pruneRoad`).
 * Determinism: a new piece only keeps clear of the `CLEARANCE_WINDOW` of road before it (so old,
 * deleted ground can be reused), and the generator works `COMMIT_BUFFER` beyond what it hands
 * out: only that "committed" road is ever used, and backing out of a dead end never touches it.
 *
 * Every point of the world has an owner on the road: the nearest centerline sample (among the
 * ones still in play). Its distance along the road is what the destruction front advances along.
 *
 * Angles are screen angles like a car's: 0 = east, +π/2 = south (+y is down), so north is -π/2
 * and a positive turn is clockwise (to the right).
 */

export const STRAIGHT_MIN_LENGTH = 400;
export const STRAIGHT_MAX_LENGTH = 2000;
export const CORNER_MIN_RADIUS = 400;
export const CORNER_MAX_RADIUS = 2000;
export const CORNER_MAX_TURN = (120 * Math.PI) / 180;
/** The first piece: a straight north from the origin, long enough for the spawn grid. */
export const START_STRAIGHT_LENGTH = 2000;

/** Road kept generated ahead of the leading car (along the road). */
export const ROAD_AHEAD = 10000;
/** Road further than this behind the destruction front is deleted (and the ground restored). */
export const ROAD_KEEP_BEHIND = 4000;
/**
 * Deleted road still owns its ground (keeps it restored rather than letting the road ahead claim
 * it) for this much further back.
 */
const OWNER_WINDOW = 3000;

const HEADING_NORTH = -Math.PI / 2;
/** Centerlines of different stretches of road stay at least this far apart (no crossings). */
const CLEARANCE = 1200;
/**
 * Stretches closer than this along the road are allowed nearer than `CLEARANCE` (a tight bend
 * brings the road back alongside itself; that's not a crossing).
 */
const CLEARANCE_SKIP = Math.PI * CLEARANCE;
/**
 * How far back along the road a new piece keeps clear of. Older road (long deleted) may be
 * crossed: its ground has been restored. Well beyond `ROAD_AHEAD + ROAD_KEEP_BEHIND`, so a new
 * piece only reaches road still there if a car leads the front by more than ~7000.
 */
const CLEARANCE_WINDOW = 12_000;
/**
 * The generator runs this far beyond the committed road; it backtracks only within it. It must be
 * deep enough to back out of the road curling itself in: at 3000 it got stuck for seconds; at
 * 15 000 a 1 s step of generation takes at most ~20 ms, and a forced (possibly crossing) piece is
 * a few times in tens of millions of units.
 */
const COMMIT_BUFFER = 15_000;
/** Rolls per piece before backing up (removing pieces) to get out of a dead end. */
const PIECE_ATTEMPTS = 30;
/** Pruned sample data trails everything still needed by this much (client replays go back a bit). */
const PRUNE_MARGIN = 2000;

/** Distance between centerline samples. */
const SAMPLE_STEP = 25;
/** Spatial grid cell for looking up samples. */
const CELL = 400;
/** How many rings of cells to search before falling back to a brute-force search. */
const MAX_RING = 6;

export type RoadPiece =
  | { kind: "straight", x: number, y: number, heading: number, startS: number, length: number; }
  | {
    kind: "corner", x: number, y: number, heading: number, startS: number, length: number,
    radius: number, /** Signed: + = right (clockwise), - = left. */ turn: number,
  };

/** A point on the centerline: position, heading and distance along the road. */
export interface RoadSample {
  x: number;
  y: number;
  heading: number;
  s: number;
}

/** A chunk's owner (nearest sample), memoized; see `chunkOwnerS`. */
interface ChunkOwner {
  /** Absolute sample index of the owner. */
  index: number;
  dist: number;
  /** Committed samples (absolute end index) it was checked against. */
  checkedTo: number;
}

export interface Road {
  seed: number;
  /** Every piece generated so far: the committed ones first, then the generator's pending ones. */
  pieces: RoadPiece[];
  committedPieces: number;
  /** Length of the committed road: the road in use ends here. */
  committedLength: number;
  /** Centerline samples every `SAMPLE_STEP`; `samples[k]` has absolute index `sampleBase + k`. */
  samples: RoadSample[];
  sampleBase: number;
  /** Absolute index just past the last committed sample. */
  committedSamples: number;
  /** Absolute sample indices by grid cell (`cellKey`), ascending. */
  grid: Map<number, number[]>;
  /** Chunk owners by chunk key (see destruction.ts). */
  chunkCache: Map<number, ChunkOwner>;
  /** Samples with `s` below this have been dropped. */
  prunedS: number;
  /** Generator state. */
  rand: () => number;
  pieceSamples: number[];
  stuck: number;
  furthest: number;
}

/** mulberry32: a small seeded PRNG (integer math, the same everywhere). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Key of a grid cell; unique for any cell within ±2 000 000 units. */
const cellKey = (cx: number, cy: number) => (cx + 5000) * 10000 + (cy + 5000);
const cellOf = (sample: RoadSample) => cellKey(Math.floor(sample.x / CELL), Math.floor(sample.y / CELL));

/** The sample with an absolute index. */
export const sampleAt = (road: Road, index: number): RoadSample => road.samples[index - road.sampleBase];

/** Position and heading at distance `u` into a piece. */
export function pointOnPiece(piece: RoadPiece, u: number, out: RoadSample = { x: 0, y: 0, heading: 0, s: 0 }): RoadSample {
  out.s = piece.startS + u;
  if (piece.kind === "straight") {
    out.x = piece.x + Math.cos(piece.heading) * u;
    out.y = piece.y + Math.sin(piece.heading) * u;
    out.heading = piece.heading;
    return out;
  }
  const side = Math.sign(piece.turn);
  // The circle's center is `radius` to the turning side of the start
  const cx = piece.x + Math.cos(piece.heading + side * Math.PI / 2) * piece.radius;
  const cy = piece.y + Math.sin(piece.heading + side * Math.PI / 2) * piece.radius;
  const heading = piece.heading + side * (u / piece.radius);
  out.x = cx + Math.cos(heading - side * Math.PI / 2) * piece.radius;
  out.y = cy + Math.sin(heading - side * Math.PI / 2) * piece.radius;
  out.heading = heading;
  return out;
}

/** Samples along a piece, every `SAMPLE_STEP` along the whole road (the piece's start, not its end). */
function samplePiece(piece: RoadPiece): RoadSample[] {
  const samples: RoadSample[] = [];
  const first = Math.ceil(piece.startS / SAMPLE_STEP) * SAMPLE_STEP;
  for (let s = first; s < piece.startS + piece.length; s += SAMPLE_STEP) {
    samples.push(pointOnPiece(piece, s - piece.startS));
  }
  return samples;
}

/** Whether a candidate piece stays `CLEARANCE` away from the recent road (bar the last stretch). */
function hasClearance(road: Road, candidate: RoadSample[]): boolean {
  const rings = Math.ceil(CLEARANCE / CELL);
  for (const point of candidate) {
    const cx = Math.floor(point.x / CELL);
    const cy = Math.floor(point.y / CELL);
    for (let dx = -rings; dx <= rings; dx++) {
      for (let dy = -rings; dy <= rings; dy++) {
        const cell = road.grid.get(cellKey(cx + dx, cy + dy));
        if (!cell) continue;
        for (const index of cell) {
          const other = sampleAt(road, index);
          const behind = point.s - other.s;
          if (behind < CLEARANCE_SKIP || behind > CLEARANCE_WINDOW) continue;
          if (Math.hypot(point.x - other.x, point.y - other.y) < CLEARANCE) return false;
        }
      }
    }
  }
  return true;
}

/** Roll a piece starting at `end`: a straight or a corner, 50/50. */
function rollPiece(rand: () => number, end: RoadSample): RoadPiece {
  const start = { x: end.x, y: end.y, heading: end.heading, startS: end.s };
  if (rand() < 0.5) {
    return { kind: "straight", ...start, length: STRAIGHT_MIN_LENGTH + rand() ** 2 * (STRAIGHT_MAX_LENGTH - STRAIGHT_MIN_LENGTH) };
  }
  const radius = CORNER_MIN_RADIUS + rand() * (CORNER_MAX_RADIUS - CORNER_MIN_RADIUS);
  const amount = rand() * CORNER_MAX_TURN;
  const turn = rand() < 0.5 ? -amount : amount;
  return { kind: "corner", ...start, radius, turn, length: radius * Math.abs(turn) };
}

const endOfPieces = (road: Road) => {
  const last = road.pieces[road.pieces.length - 1];
  return last.startS + last.length;
};

function addPiece(road: Road, piece: RoadPiece, samples: RoadSample[]) {
  road.pieces.push(piece);
  road.pieceSamples.push(samples.length);
  for (const sample of samples) {
    const index = road.sampleBase + road.samples.length;
    const key = cellOf(sample);
    const cell = road.grid.get(key);
    if (cell) cell.push(index);
    else road.grid.set(key, [index]);
    road.samples.push(sample);
  }
  // Pieces the generator has got far enough past are final
  const end = endOfPieces(road);
  while (road.committedPieces < road.pieces.length) {
    const next = road.pieces[road.committedPieces];
    if (next.startS + next.length > end - COMMIT_BUFFER) break;
    road.committedSamples += road.pieceSamples[road.committedPieces];
    road.committedPieces++;
    road.committedLength = next.startS + next.length;
  }
}

/** Take the last (uncommitted) piece off again. Its samples are the newest in their cells. */
function removeLastPiece(road: Road) {
  road.pieces.pop();
  for (let k = road.pieceSamples.pop(); k > 0; k--) {
    const key = cellOf(road.samples.pop());
    const cell = road.grid.get(key);
    cell.pop();
    if (cell.length === 0) road.grid.delete(key);
  }
}

/**
 * One step of the generator: add a piece, or back out of a dead end. The road may go any way, so
 * it can wind itself into a spot where no piece fits without coming too close to recent road.
 * Then it backs up, removing pieces (further each time it stays stuck) until it gets past where
 * it got stuck before. It never removes committed pieces: stuck right at them, it takes the next
 * roll as it is.
 */
function generateStep(road: Road) {
  const last = road.pieces[road.pieces.length - 1];
  const end = pointOnPiece(last, last.length);
  const canBackUp = road.pieces.length > road.committedPieces;
  for (let attempt = 0; attempt < PIECE_ATTEMPTS; attempt++) {
    const piece = rollPiece(road.rand, end);
    const samples = samplePiece(piece);
    const clear = hasClearance(road, samples);
    if (clear || (!canBackUp && attempt === PIECE_ATTEMPTS - 1)) {
      addPiece(road, piece, samples);
      // A forced piece starts over too: else it would back up to the same spot again and again
      if (!clear || endOfPieces(road) > road.furthest) {
        road.furthest = endOfPieces(road);
        road.stuck = 0;
      }
      return;
    }
  }
  road.stuck++;
  for (let k = 0; k < road.stuck && road.pieces.length > road.committedPieces; k++) removeLastPiece(road);
}

/** A new road for a seed, with its first piece. Prefer `getRoad`, which caches. */
export function buildRoad(seed: number): Road {
  const road: Road = {
    seed, pieces: [], committedPieces: 0, committedLength: 0,
    samples: [], sampleBase: 0, committedSamples: 0, grid: new Map(), chunkCache: new Map(), prunedS: -Infinity,
    rand: random(seed), pieceSamples: [], stuck: 0, furthest: 0,
  };
  const first: RoadPiece = { kind: "straight", x: 0, y: 0, heading: HEADING_NORTH, startS: 0, length: START_STRAIGHT_LENGTH };
  addPiece(road, first, samplePiece(first));
  ensureRoad(road, ROAD_AHEAD + START_STRAIGHT_LENGTH);
  return road;
}

/** Generate (commit) the road at least up to `s` along it. */
export function ensureRoad(road: Road, s: number) {
  while (road.committedLength < s) generateStep(road);
}

/**
 * Drop the data of road no longer needed with the front at `frontS`: deleted long enough ago
 * that it neither owns ground nor matters to new pieces. (Lookups never depend on what has been
 * pruned: everything still in play is kept, plus `PRUNE_MARGIN`.)
 */
export function pruneRoad(road: Road, frontS: number) {
  const keepFrom = Math.min(ownerWindowStart(frontS), road.committedLength - CLEARANCE_WINDOW) - PRUNE_MARGIN;
  // Only now and then: it's a sweep over the grid and the chunk cache
  if (keepFrom < road.prunedS + 1000) return;
  road.prunedS = keepFrom;

  let drop = 0;
  while (drop < road.samples.length && road.samples[drop].s < keepFrom) drop++;
  if (drop === 0) return;
  for (let k = 0; k < drop; k++) {
    const key = cellOf(road.samples[k]);
    const cell = road.grid.get(key);
    // Cells list indices in order, so a cell's oldest samples are its first ones
    cell.shift();
    if (cell.length === 0) road.grid.delete(key);
  }
  road.samples.splice(0, drop);
  road.sampleBase += drop;
  for (const [key, owner] of road.chunkCache) {
    if (owner.index < road.sampleBase) road.chunkCache.delete(key);
  }
}

const roadCache = new Map<number, Road>();

/** The road for a seed (kept per seed, for the last few seeds). */
export function getRoad(seed: number): Road {
  let road = roadCache.get(seed);
  if (!road) {
    road = buildRoad(seed);
    roadCache.set(seed, road);
    if (roadCache.size > 3) roadCache.delete(roadCache.keys().next().value);
  }
  return road;
}

/**
 * The centerline point at distance `s` along the (committed) road, clamped to its ends. Pieces
 * are never dropped, so this works for any `s` the road has passed.
 */
export function roadPointAt(road: Road, s: number, out: RoadSample = { x: 0, y: 0, heading: 0, s: 0 }): RoadSample {
  // Binary search for the last committed piece starting at or before `s`
  let lo = 0;
  let hi = Math.max(0, road.committedPieces - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (road.pieces[mid].startS <= s) lo = mid;
    else hi = mid - 1;
  }
  const piece = road.pieces[lo];
  return pointOnPiece(piece, Math.max(0, Math.min(piece.length, s - piece.startS)), out);
}

/** Where the road in play starts with the front at `frontS`: anything before is deleted. */
export const roadTail = (frontS: number) => frontS - ROAD_KEEP_BEHIND;
/** Deleted road this far back still owns its ground (see `OWNER_WINDOW`). */
export const ownerWindowStart = (frontS: number) => roadTail(frontS) - OWNER_WINDOW;

/**
 * The committed sample nearest to (x, y) with `s >= minS`, as an absolute index (-1 if none).
 * `out.dist` gets its distance.
 */
export function nearestSampleIndex(road: Road, x: number, y: number, minS: number, out = { dist: 0 }): number {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  let best = -1;
  let bestDist = Infinity;
  const consider = (index: number) => {
    if (index >= road.committedSamples) return;
    const sample = sampleAt(road, index);
    if (sample.s < minS) return;
    const dist = Math.hypot(x - sample.x, y - sample.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  };
  for (let ring = 0; ring <= MAX_RING; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        // Only the ring's border cells (the inside was searched already)
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cell = road.grid.get(cellKey(cx + dx, cy + dy));
        if (cell) for (const index of cell) consider(index);
      }
    }
    // Every cell of the next ring is at least `ring * CELL` away
    if (best >= 0 && bestDist <= ring * CELL) break;
  }
  if (best < 0 || bestDist > MAX_RING * CELL) {
    // Far from the road: check everything in play (only a few hundred samples)
    for (let index = road.sampleBase; index < road.committedSamples; index++) consider(index);
  }
  out.dist = bestDist;
  return best;
}

/** Distance along the road (in play with the front at `frontS`) of the point nearest to (x, y). */
export function roadDistanceAt(road: Road, x: number, y: number, frontS: number): number {
  const index = nearestSampleIndex(road, x, y, roadTail(frontS));
  return index < 0 ? roadTail(frontS) : sampleAt(road, index).s;
}

const HALF_WIDTH = ROAD_WIDTH / 2;
const scratchDist = { dist: 0 };

/**
 * Whether (x, y) is on the road with the front at `frontS`: within half its width of the
 * centerline, and on road still in play (deleted road is dirt again). Square ends.
 */
export function isOnRoad(road: Road, x: number, y: number, frontS: number): boolean {
  const tail = roadTail(frontS);
  const index = nearestSampleIndex(road, x, y, tail, scratchDist);
  if (index < 0 || scratchDist.dist > HALF_WIDTH) return false;
  const sample = sampleAt(road, index);
  const along = (x - sample.x) * Math.cos(sample.heading) + (y - sample.y) * Math.sin(sample.heading);
  // Square ends: the start (or, once deleted that far, the tail), and the end of the committed road
  if (sample.s + along < Math.max(tail, 0)) return false;
  if (index === road.committedSamples - 1 && along > 0) return false;
  return true;
}

/**
 * Distance along the road of the sample owning a chunk center (x, y) with the front at `frontS`:
 * the nearest committed sample within the owner window (deleted road included, see
 * `OWNER_WINDOW`). Memoized per chunk key, and kept up to date incrementally as the road grows
 * and the window moves.
 */
export function chunkOwnerS(road: Road, key: number, x: number, y: number, frontS: number): number {
  const windowStart = ownerWindowStart(frontS);
  let owner = road.chunkCache.get(key);
  const valid = owner && owner.index >= road.sampleBase && sampleAt(road, owner.index).s >= windowStart
    && road.committedSamples - owner.checkedTo < 400;
  if (!valid) {
    const index = nearestSampleIndex(road, x, y, windowStart, scratchDist);
    owner = { index, dist: scratchDist.dist, checkedTo: road.committedSamples };
    road.chunkCache.set(key, owner);
  } else if (owner.checkedTo < road.committedSamples) {
    // Only the road committed since can be nearer
    for (let index = owner.checkedTo; index < road.committedSamples; index++) {
      const sample = sampleAt(road, index);
      const dist = Math.hypot(x - sample.x, y - sample.y);
      if (dist < owner.dist) {
        owner.index = index;
        owner.dist = dist;
      }
    }
    owner.checkedTo = road.committedSamples;
  }
  return owner.index < 0 ? windowStart : sampleAt(road, owner.index).s;
}
