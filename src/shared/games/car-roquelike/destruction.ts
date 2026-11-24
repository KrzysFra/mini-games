import { CAR_MAX_SPEED, COUNTDOWN_TICKS, DESTRUCTION_SPEED_FACTOR, PHYSICS_SUBSTEPS } from "./constants.js";
import { chunkOwnerS, roadTail, type Road } from "./road.js";

/**
 * The destruction front: the world (road and dirt alike) collapses into the void, starting at the
 * road's start and moving along the road at a steady pace a bit below the cars' top speed, from
 * the start of the round (during the countdown, the running start, the cars drive away from it
 * at top speed, out of reach). A car whose
 * center is over destroyed ground is eliminated. Once road is out of `ROAD_RADIUS` of the camera,
 * behind it, it is deleted and the ground restored (dirt again, free for new road): the void is a band
 * that follows the front.
 *
 * The front is a distance along the road (`destructionFrontS`): every point of the world has one,
 * that of its owner, the nearest point of the road's centerline (`chunkOwnerS` in road.ts), so
 * dirt goes along with the stretch of road next to it.
 *
 * Everything here is a pure function of the road and the round's tick count, so the server and
 * the predicting client agree on it, and the client can draw it without any extra network state.
 *
 * The ground is a grid of `CHUNK_SIZE` chunks. Each chunk breaks at its own point (`chunkBreakS`):
 * once the front has reached it. A chunk breaks between 0 and `CHUNK_JITTER` before the front
 * reaches its center, from a smooth noise plus a little per-chunk noise, so the edge of the void
 * is ragged instead of a straight line. Behind the front everything is void, up to where the
 * ground has been restored.
 */

export { COUNTDOWN_TICKS };
/**
 * How far the front moves along the road per physics step: `DESTRUCTION_SPEED_FACTOR` of a car's
 * top speed, i.e. `CAMERA_SPEED_PER_MINUTE` per minute.
 */
export const DESTRUCTION_SPEED = DESTRUCTION_SPEED_FACTOR * CAR_MAX_SPEED;

export const CHUNK_SIZE = 40;
/** How far ahead of the front a chunk can break (the raggedness of the edge). */
export const CHUNK_JITTER = 160;
/** Chunks per cell of the smooth noise that shapes the edge. */
const NOISE_CELL = 6;

/**
 * The front's distance along the road after `roundTick` ticks (may be fractional, for drawing):
 * moving at `DESTRUCTION_SPEED` from the start of the round, countdown included, so the running
 * start (at top speed) slowly pulls the cars away from it.
 */
export function destructionFrontS(roundTick: number): number {
  return Math.max(0, roundTick) * PHYSICS_SUBSTEPS * DESTRUCTION_SPEED;
}

/** Index of the chunk column/row containing a world coordinate. */
export const chunkIndex = (v: number): number => Math.floor(v / CHUNK_SIZE);

/** Deterministic hash of a chunk (and a salt for independent values) to 0..1. Integer math only. */
export function chunkHash(i: number, j: number, salt = 0): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smoothStep = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth 2D value noise over chunk indices, 0..1. */
function edgeNoise(i: number, j: number): number {
  const gi = Math.floor(i / NOISE_CELL);
  const gj = Math.floor(j / NOISE_CELL);
  const fx = smoothStep((i - gi * NOISE_CELL) / NOISE_CELL);
  const fy = smoothStep((j - gj * NOISE_CELL) / NOISE_CELL);
  return lerp(
    lerp(chunkHash(gi, gj, 1), chunkHash(gi + 1, gj, 1), fx),
    lerp(chunkHash(gi, gj + 1, 1), chunkHash(gi + 1, gj + 1, 1), fx),
    fy,
  );
}

/** Key of a chunk in `Road.chunkCache`; unique for chunks within ±2 000 000 units. */
const chunkKey = (i: number, j: number) => (i + 50_000) * 100_000 + (j + 50_000);

/**
 * The front distance at which chunk (i, j) breaks away with the front at `frontS` (it's void
 * while `chunkBreakS <= frontS`), or `Infinity` if its ground has been restored: its owner on the
 * road is before the road's tail (`roadTail`: that road is deleted).
 */
export function chunkBreakS(road: Road, i: number, j: number, frontS: number): number {
  const ownerS = chunkOwnerS(road, chunkKey(i, j), (i + 0.5) * CHUNK_SIZE, (j + 0.5) * CHUNK_SIZE, frontS);
  if (ownerS < roadTail(road, frontS)) return Infinity;
  const jitter = 0.7 * edgeNoise(i, j) + 0.3 * chunkHash(i, j, 2);
  return ownerS - CHUNK_JITTER * jitter;
}

/** Whether the ground at (x, y) is void with the front at `frontS`. */
export const isDestroyed = (road: Road, x: number, y: number, frontS: number): boolean =>
  chunkBreakS(road, chunkIndex(x), chunkIndex(y), frontS) <= frontS;
