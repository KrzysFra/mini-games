import { CAR_LENGTH, CAR_MAX_SPEED, CAR_WIDTH, ROAD_WIDTH } from "./constants.js";
import { clamp, type CarInput } from "./controls.js";
import { chunkHash } from "./destruction.js";
import { ensureRoad, roadDistanceAt, roadPointAt, type Road, type RoadSample } from "./road.js";

/**
 * Obstacle cars: computer-driven cars spawned on new road (server-side, `spawnObstacles` in
 * physics.ts), there to be dodged. How one drives depends on its kind, which is its color.
 *
 * Spawning is rolled per `OBSTACLE_SEGMENT` of road (`rollObstacle`, a hash of the road's seed and
 * the segment: no randomness), and an obstacle's driving (`obstacleInput`) is a pure function of
 * its car, its traits and the road, so clients predict obstacles exactly like the server runs them.
 */

/** How an obstacle kind looks, how often it spawns, and how it drives. */
export interface ObstacleKindConfig {
  color: number;
  /**
   * Share of spawned obstacles that are this kind, relative to the other kinds' (they needn't add
   * up to 1: each kind gets weight / total of all weights).
   */
  weight: number;
  /** Speed range, as a share of top speed (each car gets its own, fixed, in the range). */
  minSpeed: number;
  maxSpeed: number;
  /** 1: drives along the road (the way the players go); -1: drives the wrong way. */
  direction: 1 | -1;
  /** Steers around other cars to keep `OBSTACLE_KEEP_GAP` (else it keeps to its lane regardless). */
  avoidsCars: boolean;
}

/**
 * The obstacle kinds, by color: tune them here. (A new kind needs nothing else, unless it drives
 * in some new way: then `obstacleInput`.)
 */
export const OBSTACLE_KINDS = {
  /** Follows the road in its lane, steering around other cars to keep a car length from them. */
  brown: { color: 0x8a5a32, weight: 0.95, minSpeed: 0.5, maxSpeed: 0.9, direction: 1, avoidsCars: true },
  /** Drives the wrong way, slowly, keeping to its lane whatever is in the way. */
  red: { color: 0xc8302c, weight: 0.05, minSpeed: 0.4, maxSpeed: 0.4, direction: -1, avoidsCars: false },
} satisfies Record<string, ObstacleKindConfig>;

export type ObstacleKind = keyof typeof OBSTACLE_KINDS;

/** Kinds in a fixed order, for rolling. */
const KIND_LIST = Object.keys(OBSTACLE_KINDS) as ObstacleKind[];
const TOTAL_WEIGHT = KIND_LIST.reduce((sum, kind) => sum + OBSTACLE_KINDS[kind].weight, 0);

/** A kind's config (unknown kinds, e.g. from a newer server, drive like brown). */
export const obstacleKind = (kind: string): ObstacleKindConfig =>
  (OBSTACLE_KINDS as Record<string, ObstacleKindConfig>)[kind] ?? OBSTACLE_KINDS.brown;

/** Road is rolled for obstacles in segments of this length... */
export const OBSTACLE_SEGMENT = 100;
/** ...each spawning one with this chance (its kind is then rolled by `weight`). */
export const OBSTACLE_CHANCE = 0.3;
/** Most obstacles in the world at once (clients draw them from fixed pose slots, one per obstacle). */
export const MAX_OBSTACLES = 48;
/** Furthest an obstacle's lane is off the centerline (+ = right of the road's direction). */
export const OBSTACLE_MAX_LANE = ROAD_WIDTH / 2 - 70;
/** How far along the road ahead (its way) an obstacle aims. */
export const OBSTACLE_LOOKAHEAD = 200;
/** The road is generated at least this far ahead of every obstacle. */
const OBSTACLE_ROAD_AHEAD = 1000;

/** What an obstacle is, fixed at spawn (replicated, so clients drive it the same). */
export interface ObstacleTraits {
  kind: ObstacleKind;
  /** Throttle: the share of top speed it drives at. */
  speed: number;
  /** Offset from the road's centerline it drives at (+ = right of the road's direction). */
  lane: number;
}

/** A spawn rolled for a road segment: where along the road, and the obstacle's traits. */
export interface ObstacleSpawn extends ObstacleTraits {
  s: number;
}

/** The kind for a roll of 0..1, by weight. */
function kindForRoll(roll: number): ObstacleKind {
  let at = roll * TOTAL_WEIGHT;
  for (const kind of KIND_LIST) {
    at -= OBSTACLE_KINDS[kind].weight;
    if (at < 0) return kind;
  }
  return KIND_LIST[KIND_LIST.length - 1];
}

/**
 * The obstacle (if any) spawning in road segment `segment` of the road with seed `seed`.
 * Traits are float32-exact, as they are replicated (so server and clients use the same values).
 */
export function rollObstacle(seed: number, segment: number): ObstacleSpawn | undefined {
  if (chunkHash(segment, seed, 10) >= OBSTACLE_CHANCE) return undefined;
  const kind = kindForRoll(chunkHash(segment, seed, 14));
  const { minSpeed, maxSpeed } = OBSTACLE_KINDS[kind];
  return {
    kind,
    s: (segment + chunkHash(segment, seed, 11)) * OBSTACLE_SEGMENT,
    speed: Math.fround(minSpeed + chunkHash(segment, seed, 12) * (maxSpeed - minSpeed)),
    lane: Math.fround((chunkHash(segment, seed, 13) * 2 - 1) * OBSTACLE_MAX_LANE),
  };
}

/** Where an obstacle drives along the road: `s` along it, `lane` off the centerline. */
export function lanePoint(road: Road, s: number, lane: number, out: RoadSample = { x: 0, y: 0, heading: 0, s: 0 }): RoadSample {
  roadPointAt(road, s, out);
  // Right of the heading (+y is down, so that's +90°)
  out.x -= Math.sin(out.heading) * lane;
  out.y += Math.cos(out.heading) * lane;
  return out;
}

/**
 * Brown: the gap it keeps to every other car (bumper to bumper ahead/behind, side to side beside):
 * one car length. Only by steering: it always drives at its own speed.
 */
export const OBSTACLE_KEEP_GAP = CAR_LENGTH;
/** Furthest a brown car moves off its lane to keep its gap (stays this far inside the road's edge). */
const DODGE_MAX_LANE = ROAD_WIDTH / 2 - CAR_WIDTH;
/** Steps ahead a brown car looks for cars it's closing in on (or that are closing in on it). */
const DODGE_TIME = 25;
/** Other cars further than this (center to center) are ignored. */
const AWARE_RANGE = 600;

/** The parts of a car body an obstacle looks at (a matter body fits). */
export interface CarBodyLike {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
}

const scratchTarget: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };
const scratchHere: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };
const NO_CARS: readonly CarBodyLike[] = [];
/** Lanes of the cars coming at the obstacle being steered (reused; `obstacleInput` only). */
const oncoming: number[] = [];

/**
 * An obstacle's input for this step, by its kind (`OBSTACLE_KINDS`). Always at its own share of top
 * speed, aiming at its lane `OBSTACLE_LOOKAHEAD` along the road its way (`direction`: along the road,
 * or the wrong way) from where it is (knocked off the road, it steers back). A kind that
 * `avoidsCars` (brown) also steers to keep `OBSTACLE_KEEP_GAP` from every other car (`others`;
 * `self` among them is skipped); one that doesn't (red) keeps to its lane whatever is in the way.
 * Avoiding, in the road's frame (turned its way), a car whose path comes within that gap of its own
 * (now, or within `DODGE_TIME` at the speed they close in) pushes its lane aside until there's the
 * gap between them (around the other side if the road's edge is in the way; aiming closer when
 * it's ahead, for a sharper swerve), so it passes slower cars and makes way for faster ones. It
 * won't head for a lane closer than that to a car alongside (hemmed in on both sides: it holds
 * where it is).
 */
export function obstacleInput(
  road: Road, frontS: number, self: CarBodyLike, traits: ObstacleTraits, others: Iterable<CarBodyLike>,
  out: CarInput = { dirX: 0, dirY: 0, handbrake: false },
): CarInput {
  const { x, y } = self.position;
  const s = roadDistanceAt(road, x, y, frontS);
  // Obstacles can get ahead of the road generated around the camera: generate it ahead of them
  // (the road is one fixed sequence, so this changes no other lookup, see road.ts)
  ensureRoad(road, s + OBSTACLE_ROAD_AHEAD);

  // The road's frame here, turned the way it drives: forward, and to its right. Lanes below are in
  // it (a wrong-way car's right is the road's left)
  const { direction, avoidsCars } = obstacleKind(traits.kind);
  const here = roadPointAt(road, s, scratchHere);
  const fx = Math.cos(here.heading) * direction;
  const fy = Math.sin(here.heading) * direction;
  const ownSpeed = self.velocity.x * fx + self.velocity.y * fy;
  const ownLane = (x - here.x) * -fy + (y - here.y) * fx;
  const homeLane = traits.lane * direction;

  const corridor = CAR_WIDTH + OBSTACLE_KEEP_GAP;
  // The most any car asks it to move over, each way (squeezed from both sides, they cancel out)
  let pushRight = 0;
  let pushLeft = 0;
  let dodging = false;
  /** Bumper gap to the nearest car ahead it's swerving around. */
  let dodgeAhead = Infinity;
  /** Lanes it may head for: inside the road's edges, and clear of cars alongside. */
  let minLane = -DODGE_MAX_LANE;
  let maxLane = DODGE_MAX_LANE;
  for (const other of avoidsCars ? others : NO_CARS) {
    if (other === self) continue;
    const rx = other.position.x - x;
    const ry = other.position.y - y;
    if (Math.abs(rx) > AWARE_RANGE || Math.abs(ry) > AWARE_RANGE) continue;
    const along = rx * fx + ry * fy;
    const side = rx * -fy + ry * fx;
    const otherSpeed = other.velocity.x * fx + other.velocity.y * fy;
    const gap = Math.abs(along) - CAR_LENGTH;
    // How fast the gap shrinks (ahead: we're faster; behind: it is)
    const closing = along >= 0 ? ownSpeed - otherSpeed : otherSpeed - ownSpeed;
    if (gap >= OBSTACLE_KEEP_GAP + Math.max(0, closing) * DODGE_TIME) continue;

    if (Math.abs(side) < corridor) {
      // Paths overlapping (or about to): move over until there's the gap between us. Away from
      // it (dead in line, toward the road's middle), unless the road's edge leaves no room there
      dodging = true;
      const otherLane = ownLane + side;
      let toRight = Math.abs(side) > 1e-3 ? side < 0 : ownLane <= 0;
      if (toRight && otherLane + corridor > DODGE_MAX_LANE) toRight = false;
      else if (!toRight && otherLane - corridor < -DODGE_MAX_LANE) toRight = true;
      if (toRight) pushRight = Math.max(pushRight, otherLane + corridor - ownLane);
      else pushLeft = Math.max(pushLeft, ownLane - (otherLane - corridor));
      if (along > 0) dodgeAhead = Math.min(dodgeAhead, gap);
      // Coming at us (a wrong-way car): a head-on stalls both, so it must be dodged whatever else
      if (along > 0 && otherSpeed < 0) oncoming.push(otherLane);
    } else if (side > 0) {
      // Alongside (or about to be), the gap kept: don't move over toward it
      maxLane = Math.min(maxLane, ownLane + side - corridor);
    } else {
      minLane = Math.max(minLane, ownLane + side + corridor);
    }
  }

  // Dodging: over from where it is (holding there while passing); else back to its own lane. Not
  // toward a car alongside (hemmed in on both sides: hold where it is), unless that would leave it
  // in the way of a car coming at it: then it squeezes past the car alongside rather than meet
  // the other head-on
  const wanted = dodging ? ownLane + pushRight - pushLeft : homeLane;
  let lane = minLane > maxLane ? ownLane : clamp(wanted, minLane, maxLane);
  if (oncoming.some(otherLane => Math.abs(lane - otherLane) < corridor)) {
    lane = clamp(wanted, -DODGE_MAX_LANE, DODGE_MAX_LANE);
  }
  oncoming.length = 0;
  // Swerving around a car ahead: be over halfway there, for a sharper swerve
  const lookahead = clamp(dodgeAhead / 2, CAR_LENGTH, OBSTACLE_LOOKAHEAD);
  const target = lanePoint(road, s + lookahead * direction, lane * direction, scratchTarget);
  const dx = target.x - x;
  const dy = target.y - y;
  const length = Math.hypot(dx, dy) || 1;
  out.dirX = (dx / length) * traits.speed;
  out.dirY = (dy / length) * traits.speed;
  out.handbrake = false;
  return out;
}

/**
 * An obstacle's velocity along the road's direction when it spawns: already driving at its own
 * pace, its way (negative: the wrong way).
 */
export const obstacleSpawnSpeed = (traits: ObstacleTraits) =>
  traits.speed * CAR_MAX_SPEED * obstacleKind(traits.kind).direction;
