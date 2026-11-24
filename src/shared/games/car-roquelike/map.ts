import { CAR_LENGTH } from "./constants.js";
import { CHUNK_JITTER, chunkHash } from "./destruction.js";

/** An axis-aligned static rectangle, by its center. */
export interface MapBlock {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpawnPoint {
  x: number;
  y: number;
  angle: number;
}

/** A few "buildings" to drive around. */
const BUILDINGS: MapBlock[] = [
  // { x: 800, y: 700, width: 400, height: 300 },
];

/** Everything static in the world. Client draws it, both sides build bodies from it. */
export const MAP_BLOCKS: readonly MapBlock[] = [...BUILDINGS];

/**
 * How far up the road (from its start at the origin, where the destruction front starts) the back
 * row's base slots are: 150 beyond the furthest the front's ragged edge reaches (`CHUNK_JITTER`),
 * before the stagger (`spawnPoint`). During the running start the cars drive at top speed and the
 * front follows at `DESTRUCTION_SPEED`, so they slowly pull away from it.
 */
const SPAWN_HEAD_START = CHUNK_JITTER + 150;

/**
 * The base slot per seat (`MAX_PLAYERS_PER_ROOM`): two rows of four on the road's first piece
 * (always a straight north from the origin, `START_STRAIGHT_LENGTH`), facing north. Each round
 * staggers them (`spawnPoint`): that is where the running start begins (`runningStartPose` in
 * physics.ts).
 */
export const SPAWN_POINTS: readonly SpawnPoint[] = Array.from({ length: 8 }, (_, i) => ({
  x: ((i % 4) - 1.5) * 100,
  y: -SPAWN_HEAD_START - Math.floor(i / 4) * 100,
  angle: -Math.PI / 2,
}));

/** Each round every slot moves up the road by a random 1..2 car lengths (the rows, 100 apart, stay apart). */
export const SPAWN_STAGGER_MIN = CAR_LENGTH;
export const SPAWN_STAGGER_MAX = 2 * CAR_LENGTH;

/**
 * A seat's spawn point in the round with road seed `seed`: its `SPAWN_POINTS` slot moved up the
 * road (north) by `SPAWN_STAGGER_MIN..MAX`, from a hash of (seat, seed), so the grid isn't lined
 * up and every side agrees on it.
 */
export function spawnPoint(seat: number, seed: number, out: SpawnPoint = { x: 0, y: 0, angle: 0 }): SpawnPoint {
  const base = SPAWN_POINTS[seat % SPAWN_POINTS.length];
  // Whole units: exact in the float32 state
  const stagger = Math.round(SPAWN_STAGGER_MIN + chunkHash(seat, seed, 30) * (SPAWN_STAGGER_MAX - SPAWN_STAGGER_MIN));
  out.x = base.x;
  out.y = base.y - stagger;
  out.angle = base.angle;
  return out;
}
