import {
  CAMERA_AHEAD_OF_FRONT, ROAD_WIDTH, RUNNING_START_DISTANCE, VIEW_HALF_HEIGHT, VIEW_HALF_WIDTH,
} from "./constants.js";

/**
 * The randomly generated, endless road: a chain of straights and corners. It starts at the origin
 * heading north (the first piece is a fixed straight, where the cars spawn) and may then go any way.
 *
 * The road in play is a stretch around the camera (which sits on the road, `CAMERA_AHEAD_OF_FRONT`
 * ahead of the destruction front; see camera.ts), measured along the road:
 * - ahead, every piece that starts within `ROAD_AHEAD` of the camera (`roadEnd`);
 * - behind, up to `ROAD_BEHIND` (`roadTail`). Road before that is deleted (the ground under it is
 *   restored, see destruction.ts) and never comes back, even if the road turns back toward it.
 * Both ends are pure functions of the front, so every side agrees on them.
 *
 * Two guarantees, from what the generator lets the road do (`hasClearance`):
 * - No pop-in or pop-out: stretches of road `VIEW_SEPARATION` or more apart along it are never in
 *   the same view (road included, plus `VIEW_MARGIN`). Pieces come into play `ROAD_AHEAD`
 *   ahead of the camera and are deleted `ROAD_BEHIND` behind it, both beyond that, so off screen.
 * - No crossings: road keeps `CLEARANCE` from all other road (bar the stretch right before it,
 *   `CLEARANCE_SKIP`) that can be in play at the same time (`CLEARANCE_WINDOW`). Older road may be
 *   crossed: it's deleted, dirt again, by the time the new road comes into play.
 *
 * The road is one fixed, endless sequence of pieces per seed, so the server and every client get
 * exactly the same road however far, and whenever, each of them has generated it: the generator
 * works `COMMIT_BUFFER` beyond what it hands out ("committed" road), and backing out of a dead
 * end never touches committed road. It never gets stuck there either: road is only committed up to
 * an "open" piece end, one with a clear straight run ahead (`isOpenEnd`), and from there a straight
 * always fits.
 *
 * Every point of the world has an owner on the road: the nearest centerline sample (among the
 * ones in play). Its distance along the road is what the destruction front advances along.
 *
 * Angles are screen angles like a car's: 0 = east, +π/2 = south (+y is down), so north is -π/2
 * and a positive turn is clockwise (to the right).
 */

export const STRAIGHT_MIN_LENGTH = 400;
export const STRAIGHT_MAX_LENGTH = 2000;
export const CORNER_MIN_RADIUS = 400;
export const CORNER_MAX_RADIUS = 2000;
export const CORNER_MAX_TURN = (160 * Math.PI) / 180;
/**
 * The first piece: a straight north from the origin with the spawn grid on it, long enough that
 * the whole running start (`RUNNING_START_DISTANCE`) shows nothing but it, up to the top of the
 * view (2200 beyond the destruction front, at `CAMERA_ZOOM` 0.45; the front is a bit behind the
 * cars' running start, so this is more than enough).
 */
export const START_STRAIGHT_LENGTH = RUNNING_START_DISTANCE + 2400;

/**
 * Road in play reaches this far behind the camera, along the road; and road this close (straight
 * line) to the camera gets its obstacles rolled (physics.ts). Both are at least
 * `VIEW_SEPARATION`, so off screen.
 */
export const ROAD_RADIUS = 5000;
export const ROAD_BEHIND = ROAD_RADIUS;
/**
 * A piece comes into play once its start is this close ahead of the camera, along the road. More
 * than `VIEW_SEPARATION`, by as much as the camera may move between two updates.
 */
export const ROAD_AHEAD = 5500;
/**
 * Road this far apart along the road is never in the same view (with `VIEW_MARGIN`). At least the
 * view's half diagonal plus the margin, so a straight passes; at most `ROAD_BEHIND` and
 * `ROAD_AHEAD` (less the camera's step).
 */
export const VIEW_SEPARATION = 4500;
/** Beyond the view's edge, road (its centerline) is off screen by this much. */
const VIEW_MARGIN = ROAD_WIDTH / 2 + 150;
const VIEW_REACH_X = VIEW_HALF_WIDTH + VIEW_MARGIN;
const VIEW_REACH_Y = VIEW_HALF_HEIGHT + VIEW_MARGIN;
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
/** The longest piece there can be. */
const MAX_PIECE_LENGTH = Math.max(STRAIGHT_MAX_LENGTH, CORNER_MAX_RADIUS * CORNER_MAX_TURN);
/**
 * How far back along the road new road keeps clear of: everything that can be in play with it. A
 * piece is in play from when the camera is `ROAD_AHEAD` before its start, and so is road up to
 * `ROAD_BEHIND` behind the camera. Older road may be crossed: it's deleted by then.
 */
const CLEARANCE_WINDOW = ROAD_AHEAD + ROAD_BEHIND + MAX_PIECE_LENGTH;
/**
 * The generator runs this far beyond the committed road; it backtracks only within it. It must be
 * deep enough to back out of the road curling itself in.
 */
const COMMIT_BUFFER = 15_000;
/** Rolls per piece before backing up (removing pieces) to get out of a dead end. */
const PIECE_ATTEMPTS = 30;
/** Pruned sample data trails everything still needed by this much (client replays go back a bit). */
const PRUNE_MARGIN = 2000;
/**
 * An open end's straight run is checked this much more strictly, so the straights later laid
 * along it (whose samples land on it, give or take rounding) surely pass.
 */
const OPEN_END_TOLERANCE = 1;

/** Distance between centerline samples. */
const SAMPLE_STEP = 25;
/** Spatial grid cell for looking up samples. */
const CELL = 400;
/** How many rings of cells to search before falling back to a brute-force search. */
const MAX_RING = 6;
/** Rings of cells within reach of the clearance checks. */
const CHECK_RINGS_X = Math.ceil(Math.max(CLEARANCE, VIEW_REACH_X) / CELL) + 1;
const CHECK_RINGS_Y = Math.ceil(Math.max(CLEARANCE, VIEW_REACH_Y) / CELL) + 1;

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
  /** Samples in play (absolute end index) it was checked against. */
  checkedTo: number;
}

export interface Road {
  seed: number;
  /** Every piece generated so far: the committed ones first, then the generator's pending ones. */
  pieces: RoadPiece[];
  committedPieces: number;
  /** Length of the committed road: the road generated for good ends here. */
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
  /** Per piece: whether its end is open (`isOpenEnd`); road is only committed up to one. */
  pieceOpen: boolean[];
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

/**
 * Whether new road (`candidate`, past all the road generated) may go there: each of its points
 * keeps `CLEARANCE` from the road up to `CLEARANCE_WINDOW` before it (bar the last
 * `CLEARANCE_SKIP`), and out of the view (+`VIEW_MARGIN`) around any of it `VIEW_SEPARATION` or
 * more before it. `tolerance` makes it stricter by that much.
 */
function hasClearance(road: Road, candidate: RoadSample[], tolerance = 0): boolean {
  const clearance = CLEARANCE + tolerance;
  const reachX = VIEW_REACH_X + tolerance;
  const reachY = VIEW_REACH_Y + tolerance;
  for (const point of candidate) {
    const cx = Math.floor(point.x / CELL);
    const cy = Math.floor(point.y / CELL);
    for (let dx = -CHECK_RINGS_X; dx <= CHECK_RINGS_X; dx++) {
      for (let dy = -CHECK_RINGS_Y; dy <= CHECK_RINGS_Y; dy++) {
        const cell = road.grid.get(cellKey(cx + dx, cy + dy));
        if (!cell) continue;
        for (const index of cell) {
          const other = sampleAt(road, index);
          const behind = point.s - other.s;
          if (behind < CLEARANCE_SKIP - tolerance || behind > CLEARANCE_WINDOW + tolerance) continue;
          const ox = Math.abs(point.x - other.x);
          const oy = Math.abs(point.y - other.y);
          if (Math.hypot(ox, oy) < clearance) return false;
          if (behind >= VIEW_SEPARATION - tolerance && ox <= reachX && oy <= reachY) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Whether the end of the road generated so far is open: a straight on from it would pass
 * `hasClearance` for as far as the road before it matters (`CLEARANCE_WINDOW`). Then straights
 * along it always fit, and their ends are open too (their straight runs are part of this one).
 *
 * Checked exactly (stricter than `hasClearance`'s samples): each sample of the road in the window
 * against the stretch of the straight run its rules apply to.
 */
function isOpenEnd(road: Road): boolean {
  const last = road.pieces[road.pieces.length - 1];
  const end = pointOnPiece(last, last.length);
  const ux = Math.cos(end.heading);
  const uy = Math.sin(end.heading);
  const tolerance = OPEN_END_TOLERANCE;
  const first = Math.max(road.sampleBase, Math.floor((end.s - CLEARANCE_WINDOW - tolerance) / SAMPLE_STEP));
  const count = road.sampleBase + road.samples.length;
  for (let index = first; index < count; index++) {
    const other = sampleAt(road, index);
    const px = other.x - end.x;
    const py = other.y - end.y;
    // The run's point t along it is `end.s + t - other.s` after `other` along the road
    const t1 = other.s - end.s + CLEARANCE_WINDOW + tolerance;
    const t0 = Math.max(0, other.s - end.s + CLEARANCE_SKIP - tolerance);
    if (t0 > t1) continue;
    const along = Math.max(t0, Math.min(t1, px * ux + py * uy));
    if (Math.hypot(px - along * ux, py - along * uy) < CLEARANCE + tolerance) return false;
    const v0 = Math.max(0, other.s - end.s + VIEW_SEPARATION - tolerance);
    if (v0 <= t1 && crossesBox(px, py, ux, uy, v0, t1, VIEW_REACH_X + tolerance, VIEW_REACH_Y + tolerance)) return false;
  }
  return true;
}

/** Whether the segment t·(ux, uy), t in [t0, t1], meets the box of half size (rx, ry) at (px, py). */
function crossesBox(px: number, py: number, ux: number, uy: number, t0: number, t1: number, rx: number, ry: number): boolean {
  const slab = (p: number, u: number, r: number) => {
    if (Math.abs(u) < 1e-12) return Math.abs(p) <= r;
    const a = (p - r) / u;
    const b = (p + r) / u;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    return t0 <= t1;
  };
  return slab(px, ux, rx) && slab(py, uy, ry);
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
  road.pieceOpen.push(isOpenEnd(road));

  // Pieces the generator has got far enough past are final, up to the last open end among them
  const limit = endOfPieces(road) - COMMIT_BUFFER;
  let lastOpen = -1;
  for (let k = road.committedPieces; k < road.pieces.length; k++) {
    const next = road.pieces[k];
    if (next.startS + next.length > limit) break;
    if (road.pieceOpen[k]) lastOpen = k;
  }
  for (; road.committedPieces <= lastOpen; road.committedPieces++) {
    const next = road.pieces[road.committedPieces];
    road.committedSamples += road.pieceSamples[road.committedPieces];
    road.committedLength = next.startS + next.length;
  }
}

/** Take the last (uncommitted) piece off again. Its samples are the newest in their cells. */
function removeLastPiece(road: Road) {
  road.pieces.pop();
  road.pieceOpen.pop();
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
 * it got stuck before. It never removes committed pieces: stuck right at them, it lays a straight
 * (the committed road ends at an open end, so that fits).
 */
function generateStep(road: Road) {
  const last = road.pieces[road.pieces.length - 1];
  const end = pointOnPiece(last, last.length);
  for (let attempt = 0; attempt < PIECE_ATTEMPTS; attempt++) {
    const piece = rollPiece(road.rand, end);
    const samples = samplePiece(piece);
    if (hasClearance(road, samples)) {
      addPiece(road, piece, samples);
      if (endOfPieces(road) > road.furthest) {
        road.furthest = endOfPieces(road);
        road.stuck = 0;
      }
      return;
    }
  }
  if (road.pieces.length === road.committedPieces) {
    const straight: RoadPiece = {
      kind: "straight", x: end.x, y: end.y, heading: end.heading, startS: end.s, length: STRAIGHT_MAX_LENGTH,
    };
    addPiece(road, straight, samplePiece(straight));
    // Start over from here: else it would back up to the same spot again and again
    road.furthest = endOfPieces(road);
    road.stuck = 0;
    return;
  }
  road.stuck++;
  for (let k = 0; k < road.stuck && road.pieces.length > road.committedPieces; k++) removeLastPiece(road);
}

/** A new road for a seed, with its first piece. Prefer `getRoad`, which caches. */
export function buildRoad(seed: number): Road {
  const road: Road = {
    seed, pieces: [], committedPieces: 0, committedLength: 0,
    samples: [], sampleBase: 0, committedSamples: 0, grid: new Map(), chunkCache: new Map(), prunedS: -Infinity,
    rand: random(seed), pieceSamples: [], pieceOpen: [], stuck: 0, furthest: 0,
  };
  const first: RoadPiece = { kind: "straight", x: 0, y: 0, heading: HEADING_NORTH, startS: 0, length: START_STRAIGHT_LENGTH };
  addPiece(road, first, samplePiece(first));
  // It's fixed: committed right away, so the generator never backs out of it
  road.committedPieces = 1;
  road.committedSamples = road.samples.length;
  road.committedLength = START_STRAIGHT_LENGTH;
  ensureRoadAround(road, 0);
  return road;
}

/** Generate (commit) the road at least up to `s` along it. */
export function ensureRoad(road: Road, s: number) {
  while (road.committedLength < s) generateStep(road);
}

/** Distance along the road of the camera's center with the front at `frontS`. */
export const cameraS = (frontS: number) => frontS + CAMERA_AHEAD_OF_FRONT;

/** Index of the committed piece at `s` along the road (clamped to the committed road). */
function pieceIndexAt(road: Road, s: number): number {
  // Binary search for the last committed piece starting at or before `s`
  let lo = 0;
  let hi = Math.max(0, road.committedPieces - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (road.pieces[mid].startS <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * How many pieces are (or have been) in play with the front at `frontS`: those starting within
 * `ROAD_AHEAD` ahead of the camera. Generates them.
 */
export function piecesInPlay(road: Road, frontS: number): number {
  const s = cameraS(frontS) + ROAD_AHEAD;
  ensureRoad(road, s + SAMPLE_STEP);
  return pieceIndexAt(road, s) + 1;
}

/** Where (along the road) the road in play ends with the front at `frontS`. */
export function roadEnd(road: Road, frontS: number): number {
  const piece = road.pieces[piecesInPlay(road, frontS) - 1];
  return piece.startS + piece.length;
}

/** Absolute index just past the last sample in play with the front at `frontS`. */
const endIndex = (road: Road, frontS: number) => Math.ceil(roadEnd(road, frontS) / SAMPLE_STEP);

/** Generate (commit) the road in play with the front at `frontS`. */
export function ensureRoadAround(road: Road, frontS: number) {
  piecesInPlay(road, frontS);
}

/**
 * Drop the data of road no longer needed with the front at `frontS`: deleted long enough ago
 * that it neither owns ground nor matters to new pieces. (Lookups never depend on what has been
 * pruned: everything still in play is kept, plus `PRUNE_MARGIN`.)
 */
export function pruneRoad(road: Road, frontS: number) {
  const keepFrom = Math.min(ownerWindowStart(road, frontS), road.committedLength - CLEARANCE_WINDOW) - PRUNE_MARGIN;
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
  const piece = road.pieces[pieceIndexAt(road, s)];
  return pointOnPiece(piece, Math.max(0, Math.min(piece.length, s - piece.startS)), out);
}

/**
 * Where (along the road) the road in play starts with the front at `frontS`: anything before is
 * deleted. `ROAD_BEHIND` behind the camera (on a sample), so it never moves back.
 */
export const roadTail = (_road: Road, frontS: number) =>
  Math.max(0, Math.ceil((cameraS(frontS) - ROAD_BEHIND) / SAMPLE_STEP)) * SAMPLE_STEP;
/** Deleted road this far back still owns its ground (see `OWNER_WINDOW`). */
export const ownerWindowStart = (road: Road, frontS: number) => roadTail(road, frontS) - OWNER_WINDOW;

/**
 * The sample nearest to (x, y) with `s >= minS` and an absolute index below `endIndex`, as an
 * absolute index (-1 if none). `out.dist` gets its distance.
 */
function nearestSampleIndex(road: Road, x: number, y: number, minS: number, end: number, out = { dist: 0 }): number {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  let best = -1;
  let bestDist = Infinity;
  const consider = (index: number) => {
    if (index >= end) return;
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
    for (let index = road.sampleBase; index < end; index++) consider(index);
  }
  out.dist = bestDist;
  return best;
}

/** Distance along the road (in play with the front at `frontS`) of the point nearest to (x, y). */
export function roadDistanceAt(road: Road, x: number, y: number, frontS: number): number {
  const index = nearestSampleIndex(road, x, y, roadTail(road, frontS), endIndex(road, frontS));
  return index < 0 ? roadTail(road, frontS) : sampleAt(road, index).s;
}

const HALF_WIDTH = ROAD_WIDTH / 2;
const scratchDist = { dist: 0 };

/**
 * Whether (x, y) is on the road with the front at `frontS`: within half its width of the
 * centerline, and on road in play (deleted road is dirt again, and so is road not in play yet).
 * Square ends.
 */
export function isOnRoad(road: Road, x: number, y: number, frontS: number): boolean {
  const tail = roadTail(road, frontS);
  const end = endIndex(road, frontS);
  const index = nearestSampleIndex(road, x, y, tail, end, scratchDist);
  if (index < 0 || scratchDist.dist > HALF_WIDTH) return false;
  const sample = sampleAt(road, index);
  const along = (x - sample.x) * Math.cos(sample.heading) + (y - sample.y) * Math.sin(sample.heading);
  // Square ends: the start (or, once deleted that far, the tail), and the end of the road in play
  if (sample.s + along < tail) return false;
  if (index === end - 1 && along > 0) return false;
  return true;
}

/**
 * Distance along the road of the sample owning a chunk center (x, y) with the front at `frontS`:
 * the nearest sample in play or in the owner window (deleted road included, see `OWNER_WINDOW`).
 * Memoized per chunk key, and kept up to date incrementally as the road in play grows and the
 * window moves.
 */
export function chunkOwnerS(road: Road, key: number, x: number, y: number, frontS: number): number {
  const windowStart = ownerWindowStart(road, frontS);
  const end = endIndex(road, frontS);
  let owner = road.chunkCache.get(key);
  // Checked against road no longer in play (a replay from an earlier front): start over
  const valid = owner && owner.index >= road.sampleBase && sampleAt(road, owner.index).s >= windowStart
    && owner.checkedTo <= end && end - owner.checkedTo < 400;
  if (!valid) {
    const index = nearestSampleIndex(road, x, y, windowStart, end, scratchDist);
    owner = { index, dist: scratchDist.dist, checkedTo: end };
    road.chunkCache.set(key, owner);
  } else if (owner.checkedTo < end) {
    // Only the road come into play since can be nearer
    for (let index = owner.checkedTo; index < end; index++) {
      const sample = sampleAt(road, index);
      const dist = Math.hypot(x - sample.x, y - sample.y);
      if (dist < owner.dist) {
        owner.index = index;
        owner.dist = dist;
      }
    }
    owner.checkedTo = end;
  }
  return owner.index < 0 ? windowStart : sampleAt(road, owner.index).s;
}
