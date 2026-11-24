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

/** How an obstacle kind looks and drives (how often it spawns: `OBSTACLE_WEIGHTS`). */
export interface ObstacleKindConfig {
  color: number;
  /** Speed range, as a share of top speed (each car gets its own, fixed, in the range). */
  minSpeed: number;
  maxSpeed: number;
  /** 1: drives along the road (the way the players go); -1: drives the wrong way. */
  direction: 1 | -1;
  /** Steers around other cars to keep `OBSTACLE_KEEP_GAP` (else it keeps to its lane regardless). */
  avoidsCars: boolean;
  /**
   * > 0: rams a player car that is next to it: level with it (along the road, centers at most
   * `ATTACK_ALONGSIDE` apart) and at most this far to its side (center to center; the closest if
   * several). At its own speed, leaving its lane and ignoring `avoidsCars` while the player is
   * there. <= 0: never.
   */
  playerAttackDistance: number;
}

/**
 * The obstacle kinds, by color: tune them here. (A new kind needs nothing else, unless it drives
 * in some new way: then `obstacleInput`.)
 */
export const OBSTACLE_KINDS = {
  /** Follows the road in its lane, steering around other cars to keep a car length from them. */
  brown: { color: 0x8a5a32, minSpeed: 0.5, maxSpeed: 0.9, direction: 1, avoidsCars: true, playerAttackDistance: 0 },
  /** Drives the wrong way, slowly, keeping to its lane whatever is in the way. */
  red: { color: 0xc8302c, minSpeed: 0.2, maxSpeed: 0.4, direction: -1, avoidsCars: false, playerAttackDistance: 0 },
  /** Drives the wrong way, quickly, actively avoiding other cars. */
  orange: { color: 0xffa500, minSpeed: 0.8, maxSpeed: 0.8, direction: -1, avoidsCars: true, playerAttackDistance: 0 },
  /** follows the road until a player comes to close and attacks them */
  black: { color: 0x333333, minSpeed: 0.8, maxSpeed: 0.9, direction: 1, avoidsCars: true, playerAttackDistance: 200 },
} satisfies Record<string, ObstacleKindConfig>;

export type ObstacleKind = keyof typeof OBSTACLE_KINDS;

/** Kinds in a fixed order, for rolling. */
export const KIND_LIST = Object.keys(OBSTACLE_KINDS) as ObstacleKind[];

/**
 * How often each kind spawns, by distance along the road from its start: a list of
 * `[distance, weights]`, where `distance` is relative, from the previous entry's start (the first
 * one's from the road's start). Each entry applies from its start on (instantly), until the next
 * one's; the last one for good. A weight is that kind's spawn rate, in units
 * of `OBSTACLE_CHANCE` per segment: `{ brown: 1 }` spawns as many cars as `OBSTACLE_CHANCE`,
 * `{ brown: 2 }` twice that, `{ brown: 0.75, red: 0.75 }` 1.5 times that, half of each. A kind
 * left out of an entry doesn't spawn there. The lowest entry also applies before its distance.
 * (At most one obstacle per segment: totals above 1 / `OBSTACLE_CHANCE` spawn no more.)
 * camera move: 48k per minute
 */
export const OBSTACLE_WEIGHTS: ObstacleWeights = [
  [0, { brown: 1 }],
  [25000, { brown: 2 }],
  [25000, { brown: .2, red: 1 }],
  [25000, { orange: 2 }],
  [10000, { brown: 1, black: .2 }],
  [25000, { brown: 1, black: .4 }],
  [25000, { brown: 1, black: .6 }],
  [25000, { brown: 1, black: .8 }],
  [25000, { brown: 1, black: 1 }],
];

/**
 * A weights table like `OBSTACLE_WEIGHTS`: `[distance, weights]` rows. A room's settings can replace
 * the default one (`settings.ts`).
 */
export type ObstacleWeights = readonly (readonly [number, Partial<Record<ObstacleKind, number>>])[];

/** A weights table's rows at their absolute distance along the road (increasing). */
export type ObstacleWeightSteps = readonly { distance: number; weights: Partial<Record<ObstacleKind, number>>; }[];

/** `weights`' rows at their absolute distance along the road (what `obstacleWeight` reads). */
export function obstacleWeightSteps(weights: ObstacleWeights): ObstacleWeightSteps {
  let distance = 0;
  return weights.map(([offset, w]) => ({ distance: distance += Math.max(0, offset), weights: w }));
}

/** `OBSTACLE_WEIGHTS` as steps: what a world spawns with unless the room's settings say otherwise. */
export const DEFAULT_OBSTACLE_WEIGHT_STEPS = obstacleWeightSteps(OBSTACLE_WEIGHTS);

/** A kind's weight (by `steps`, a weights table) for an obstacle spawning `distance` along the road. */
export function obstacleWeight(
  kind: ObstacleKind, distance: number, steps: ObstacleWeightSteps = DEFAULT_OBSTACLE_WEIGHT_STEPS,
): number {
  let step = steps[0];
  for (const next of steps) {
    if (next.distance > distance) break;
    step = next;
  }
  return Math.max(0, step?.weights[kind] ?? 0);
}

/** A kind's config (unknown kinds, e.g. from a newer server, drive like brown). */
export const obstacleKind = (kind: string): ObstacleKindConfig =>
  (OBSTACLE_KINDS as Record<string, ObstacleKindConfig>)[kind] ?? OBSTACLE_KINDS.brown;

/** Road is rolled for obstacles in segments of this length... */
export const OBSTACLE_SEGMENT = 100;
/** ...each spawning one with this chance per 1 of total weight there (`OBSTACLE_WEIGHTS`). */
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

const scratchWeights: number[] = [];

/** The total of the kinds' weights `distance` along the road (each kind's into `scratchWeights`). */
function weightsAt(distance: number, steps: ObstacleWeightSteps): number {
  let total = 0;
  for (let i = 0; i < KIND_LIST.length; i++) total += scratchWeights[i] = obstacleWeight(KIND_LIST[i], distance, steps);
  return total;
}

/** The kind for a roll of 0..1, by the weights last put in `scratchWeights` (`weightsAt`), totalling `total`. */
function kindForRoll(roll: number, total: number): ObstacleKind {
  let at = roll * total;
  for (let i = 0; i < KIND_LIST.length; i++) {
    at -= scratchWeights[i];
    if (at < 0) return KIND_LIST[i];
  }
  // (Rounding, or every weight 0 here: the last kind with any weight, else the first)
  for (let i = KIND_LIST.length - 1; i >= 0; i--) if (scratchWeights[i] > 0) return KIND_LIST[i];
  return KIND_LIST[0];
}

/**
 * The obstacle (if any) spawning in road segment `segment` of the road with seed `seed`, by the
 * spawn weights `steps`. Traits are float32-exact, as they are replicated (so server and clients
 * use the same values).
 */
export function rollObstacle(
  seed: number, segment: number, steps: ObstacleWeightSteps = DEFAULT_OBSTACLE_WEIGHT_STEPS,
): ObstacleSpawn | undefined {
  const s = (segment + chunkHash(segment, seed, 11)) * OBSTACLE_SEGMENT;
  const total = weightsAt(s, steps);
  if (chunkHash(segment, seed, 10) >= OBSTACLE_CHANCE * total) return undefined;
  const kind = kindForRoll(chunkHash(segment, seed, 14), total);
  const { minSpeed, maxSpeed } = OBSTACLE_KINDS[kind];
  return {
    kind,
    s,
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
/** Most steps ahead an attacking obstacle leads its target by (aiming where it will be). */
const ATTACK_LEAD_MAX = 30;
/** A player counts as next to an obstacle (`playerAttackDistance`) this far ahead or behind it, at most. */
export const ATTACK_ALONGSIDE = CAR_LENGTH;

/** The parts of a car body an obstacle looks at (a matter body fits). */
export interface CarBodyLike {
  position: { x: number; y: number; };
  velocity: { x: number; y: number; };
}

const scratchTarget: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };
const scratchHere: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };
const NO_CARS: readonly CarBodyLike[] = [];
/** Lanes of the cars coming at the obstacle being steered (reused; `obstacleInput` only). */
const oncoming: number[] = [];

/**
 * The closest of `players` next to `self`: in the frame (`fx`, `fy`) forward, at most
 * `ATTACK_ALONGSIDE` ahead or behind and `range` to either side. None: undefined.
 */
function playerAlongside(
  self: CarBodyLike, players: Iterable<CarBodyLike>, fx: number, fy: number, range: number,
): CarBodyLike | undefined {
  let closest: CarBodyLike | undefined;
  let closestSide = range;
  for (const player of players) {
    const rx = player.position.x - self.position.x;
    const ry = player.position.y - self.position.y;
    if (Math.abs(rx * fx + ry * fy) > ATTACK_ALONGSIDE) continue;
    const side = Math.abs(rx * -fy + ry * fx);
    if (side <= closestSide) {
      closest = player;
      closestSide = side;
    }
  }
  return closest;
}

/**
 * Ram `target`: at its own speed (`speed`, the throttle), straight at where the target will be
 * when this car gets there (led by its velocity, at most `ATTACK_LEAD_MAX` steps, at the speed
 * they close in or this car's own).
 */
function attackInput(self: CarBodyLike, target: CarBodyLike, speed: number, out: CarInput): CarInput {
  const rx = target.position.x - self.position.x;
  const ry = target.position.y - self.position.y;
  const distance = Math.hypot(rx, ry);
  const ownSpeed = Math.hypot(self.velocity.x, self.velocity.y);
  // How fast they close in along the line between them
  const closing = distance > 1e-6
    ? ((self.velocity.x - target.velocity.x) * rx + (self.velocity.y - target.velocity.y) * ry) / distance
    : 0;
  const lead = clamp(distance / Math.max(closing, ownSpeed, 1), 0, ATTACK_LEAD_MAX);
  const dx = rx + target.velocity.x * lead;
  const dy = ry + target.velocity.y * lead;
  const length = Math.hypot(dx, dy) || 1;
  out.dirX = (dx / length) * speed;
  out.dirY = (dy / length) * speed;
  out.handbrake = false;
  return out;
}

/**
 * An obstacle's input for this step, by its kind (`OBSTACLE_KINDS`). A kind with a
 * `playerAttackDistance` > 0 rams a player next to it (`playerAlongside`, `attackInput`), whatever
 * else. Otherwise always at its own share of top
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
  players: Iterable<CarBodyLike> = NO_CARS,
  out: CarInput = { dirX: 0, dirY: 0, handbrake: false },
): CarInput {
  const { x, y } = self.position;
  const s = roadDistanceAt(road, x, y, frontS);
  // Obstacles can get ahead of the road generated around the camera: generate it ahead of them
  // (the road is one fixed sequence, so this changes no other lookup, see road.ts)
  ensureRoad(road, s + OBSTACLE_ROAD_AHEAD);

  // The road's frame here, turned the way it drives: forward, and to its right. Lanes below are in
  // it (a wrong-way car's right is the road's left)
  const { direction, avoidsCars, playerAttackDistance } = obstacleKind(traits.kind);
  const here = roadPointAt(road, s, scratchHere);
  const fx = Math.cos(here.heading) * direction;
  const fy = Math.sin(here.heading) * direction;
  if (playerAttackDistance > 0) {
    const target = playerAlongside(self, players, fx, fy, playerAttackDistance);
    if (target) return attackInput(self, target, traits.speed, out);
  }
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
