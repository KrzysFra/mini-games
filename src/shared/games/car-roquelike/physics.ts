import Matter from "matter-js";
import { cameraCenter, isOutOfView } from "./camera.js";
import {
  CAR_LENGTH, CAR_MAX_SPEED, CAR_RESTITUTION, CAR_WIDTH, DIRT_SPEED_FACTOR, PHYSICS_SUBSTEPS,
} from "./constants.js";
import { NEUTRAL_INPUT, resolveCarControls, type CarControls, type CarInput } from "./controls.js";
import { COUNTDOWN_TICKS, destructionFrontS, isDestroyed } from "./destruction.js";
import { driveCar } from "./handling.js";
import { MAP_BLOCKS, spawnPoint, type SpawnPoint } from "./map.js";
import {
  lanePoint, MAX_OBSTACLES, OBSTACLE_KEEP_GAP, OBSTACLE_MAX_LANE, OBSTACLE_SEGMENT, obstacleInput, obstacleSpawnSpeed, rollObstacle,
  DEFAULT_OBSTACLE_WEIGHT_STEPS, type ObstacleTraits, type ObstacleWeightSteps,
} from "./obstacles.js";
import {
  ensureRoadAround, getRoad, isOnRoad, pruneRoad, roadEnd, ROAD_RADIUS, START_STRAIGHT_LENGTH, type Road, type RoadSample,
} from "./road.js";

const { Bodies, Body, Composite, Engine } = Matter;

/**
 * car-roquelike's world, run identically by the server (authoritative) and by the client
 * (prediction + replay): cars, road, rounds and elimination; how a car drives is `handling.ts`.
 * Deterministic: a function of (world, inputs, step size) only — no clocks, randomness, or
 * outside reads.
 */

/** A car's full dynamic state as plain numbers (what the server replicates). */
export interface CarSnapshot {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  av: number;
}

/** An obstacle car in the world (see obstacles.ts). */
export interface ObstacleCar extends ObstacleTraits {
  body: Matter.Body;
  /** Its slot among `MAX_OBSTACLES` (clients draw it from that pose slot). */
  slot: number;
}

export interface CarWorld {
  engine: Matter.Engine;
  /** Car bodies by player id (sessionId). */
  cars: Map<string, Matter.Body>;
  /** Each car's seat (spawn point), by player id: the running start places cars by it. */
  seats: Map<string, number>;
  /** The road: decides where cars are on dirt, and the destruction. Set per round. */
  road: Road;
  /** Where the destruction front is (`stepCarRound` sets it): road far behind it is gone. */
  frontS: number;
  /** Obstacle cars by id. */
  obstacles: Map<string, ObstacleCar>;
  /** The next road segment to roll for an obstacle (`spawnObstacles`; only the server spawns). */
  obstacleSegment: number;
  /** How often each obstacle kind spawns along the road (the room's settings, else `OBSTACLE_WEIGHTS`). */
  obstacleWeights: ObstacleWeightSteps;
}

/** The road a world starts with until the round sets its own. */
export const DEFAULT_ROAD_SEED = 1;

export function createCarWorld(road: Road = getRoad(DEFAULT_ROAD_SEED)): CarWorld {
  const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
  const blocks = MAP_BLOCKS.map(b => Bodies.rectangle(b.x, b.y, b.width, b.height, { isStatic: true }));
  Composite.add(engine.world, blocks);
  return {
    engine, cars: new Map(), seats: new Map(), road, frontS: 0, obstacles: new Map(),
    obstacleSegment: FIRST_OBSTACLE_SEGMENT, obstacleWeights: DEFAULT_OBSTACLE_WEIGHT_STEPS,
  };
}

export function destroyCarWorld(world: CarWorld): void {
  Composite.clear(world.engine.world, false, true);
  Engine.clear(world.engine);
  world.cars.clear();
  world.seats.clear();
  world.obstacles.clear();
}

/**
 * Where a seat's car is after `roundTick` ticks of the running start (the countdown) in the round
 * with road seed `seed`: driving straight north from its spawn point (`spawnPoint`) at top speed.
 * From the end of the countdown on, where it is when the players take over.
 */
export function runningStartPose(
  seat: number,
  seed: number,
  roundTick: number,
  out: CarSnapshot = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, av: 0 },
): CarSnapshot {
  // North, the way every spawn faces (exactly: no trigonometry noise)
  const spawn = spawnPoint(seat, seed, scratchSpawnPoint);
  const distance = Math.max(0, Math.min(roundTick, COUNTDOWN_TICKS)) * PHYSICS_SUBSTEPS * CAR_MAX_SPEED;
  out.x = spawn.x;
  out.y = spawn.y - distance;
  out.angle = -Math.PI / 2;
  out.vx = 0;
  out.vy = -CAR_MAX_SPEED;
  out.av = 0;
  return out;
}
const scratchSpawnPoint: SpawnPoint = { x: 0, y: 0, angle: 0 };

/**
 * Add a car for a seat (replacing an existing one), from a snapshot, or else at the start of the
 * running start: on its spawn point for the world's road, already at top speed.
 */
export function addCar(world: CarWorld, id: string, seat: number, snapshot?: CarSnapshot): Matter.Body {
  removeCar(world, id);
  const body = createCarBody(world, `car:${id}`, snapshot ?? runningStartPose(seat, world.road.seed, 0, scratchPose));
  world.cars.set(id, body);
  world.seats.set(id, seat);
  return body;
}

/** A car body (players' and obstacles' alike) in the world, at a snapshot. */
function createCarBody(world: CarWorld, label: string, snapshot: CarSnapshot): Matter.Body {
  const body = Bodies.rectangle(snapshot.x, snapshot.y, CAR_LENGTH, CAR_WIDTH, {
    // Drag, grip and top speed are forces from driveCar
    frictionAir: 0,
    friction: 0.05,
    restitution: CAR_RESTITUTION,
    label,
  });
  writeCar(body, snapshot);
  Composite.add(world.engine.world, body);
  return body;
}

export function removeCar(world: CarWorld, id: string): void {
  const body = world.cars.get(id);
  if (!body) return;
  Composite.remove(world.engine.world, body);
  world.cars.delete(id);
  world.seats.delete(id);
}

/** Add an obstacle car (replacing one with the same id) at a snapshot, in a pose slot. */
export function addObstacle(world: CarWorld, id: string, traits: ObstacleTraits, slot: number, snapshot: CarSnapshot): ObstacleCar {
  removeObstacle(world, id);
  const obstacle: ObstacleCar = {
    body: createCarBody(world, `obstacle:${id}`, snapshot),
    kind: traits.kind, speed: traits.speed, lane: traits.lane, slot,
  };
  world.obstacles.set(id, obstacle);
  return obstacle;
}

export function removeObstacle(world: CarWorld, id: string): void {
  const obstacle = world.obstacles.get(id);
  if (!obstacle) return;
  Composite.remove(world.engine.world, obstacle.body);
  world.obstacles.delete(id);
}

/** Remove every obstacle, and roll from the start of the road again (a new round). */
export function clearObstacles(world: CarWorld): void {
  for (const id of [...world.obstacles.keys()]) removeObstacle(world, id);
  world.obstacleSegment = FIRST_OBSTACLE_SEGMENT;
}

/** Obstacles spawn after the first straight (the running start's). */
export const FIRST_OBSTACLE_SEGMENT = Math.ceil(START_STRAIGHT_LENGTH / OBSTACLE_SEGMENT);
/** Obstacles only spawn this far before the end of the road in play (they aim further along it). */
const SPAWN_END_MARGIN = 500;
/** No obstacle spawns this close to another car. */
const SPAWN_CLEARANCE = 2 * CAR_LENGTH;
/**
 * No wrong-way obstacle spawns with a car coming at it in its corridor closer than this: at the
 * closing speed (up to ~top speed plus its own), a car needs about this much to swerve around it.
 */
const ONCOMING_SPAWN_CLEARANCE = 500;
/**
 * Obstacles further than this from the camera are removed (a safety net: they normally stay on
 * the road, ahead of the front, until the front gets them).
 */
const OBSTACLE_DESPAWN_DISTANCE = 2 * ROAD_RADIUS;

const scratchSpawn: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };
const scratchCenter: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };

/**
 * The first obstacle segment from `segment` on that isn't in spawn reach yet with the front at
 * `frontS` (= `segment` if it isn't): every segment before it has been rolled (`spawnObstacles`).
 * Pure, so clients can follow the spawning (e.g. to show the weights in use) without spawning.
 */
export function nextObstacleSegment(road: Road, frontS: number, segment: number): number {
  const center = cameraCenter(road, frontS, scratchCenter);
  for (; ; segment++) if (!isSegmentInReach(road, frontS, segment, center)) return segment;
}

/** Whether obstacle segment `segment` is due to be rolled (on road in play, near the camera). */
function isSegmentInReach(road: Road, frontS: number, segment: number, center: RoadSample): boolean {
  const segmentEnd = (segment + 1) * OBSTACLE_SEGMENT;
  if (segmentEnd > roadEnd(road, frontS) - SPAWN_END_MARGIN) return false;
  const end = lanePoint(road, segmentEnd, 0, scratchSpawn);
  return Math.hypot(end.x - center.x, end.y - center.y) <= ROAD_RADIUS;
}

/**
 * Server only (clients adopt obstacles from the state): spawn obstacles on the road that has come
 * within `ROAD_RADIUS` of the camera since the last call (new road), with the front at `frontS`.
 * Each `OBSTACLE_SEGMENT` of road is rolled once (`rollObstacle`): it spawns in its lane, heading
 * along the road, at its own speed, unless the spot is taken or `MAX_OBSTACLES` are out.
 * New obstacles' ids are pushed to `spawned` (reused).
 */
export function spawnObstacles(world: CarWorld, frontS: number, spawned: string[] = []): string[] {
  spawned.length = 0;
  const { road } = world;
  const center = cameraCenter(road, frontS, scratchCenter);
  for (; ; world.obstacleSegment++) {
    const segment = world.obstacleSegment;
    if (!isSegmentInReach(road, frontS, segment, center)) break;

    const roll = rollObstacle(road.seed, segment, world.obstacleWeights);
    if (!roll || world.obstacles.size >= MAX_OBSTACLES) continue;
    // (Negative: the wrong way, facing back along the road)
    const speed = obstacleSpawnSpeed(roll);
    // Its lane, or (wrong way, with a car coming in it) the first of a few others that's clear
    const lanes = speed < 0 ? [roll.lane, -roll.lane, OBSTACLE_MAX_LANE, -OBSTACLE_MAX_LANE, 0] : [roll.lane];
    const lane = lanes.find(l => !isTaken(world, lanePoint(road, roll.s, l, scratchSpawn), speed < 0));
    if (lane === undefined) continue;
    roll.lane = lane;
    const at = lanePoint(road, roll.s, lane, scratchSpawn);
    const id = `o${segment}`;
    addObstacle(world, id, roll, freeObstacleSlot(world), {
      x: at.x, y: at.y, angle: speed < 0 ? at.heading + Math.PI : at.heading,
      vx: Math.cos(at.heading) * speed, vy: Math.sin(at.heading) * speed, av: 0,
    });
    spawned.push(id);
  }
  return spawned;
}

/**
 * Whether a spawn spot (a point in a lane, heading along the road) is taken: a car within
 * `SPAWN_CLEARANCE`, or, for a wrong-way spawn, one on its way toward it in its corridor within
 * `ONCOMING_SPAWN_CLEARANCE` (it couldn't swerve in time).
 */
function isTaken(world: CarWorld, at: RoadSample, wrongWay: boolean): boolean {
  const fx = Math.cos(at.heading);
  const fy = Math.sin(at.heading);
  const blocks = (body: Matter.Body) => {
    const rx = body.position.x - at.x;
    const ry = body.position.y - at.y;
    if (Math.hypot(rx, ry) < SPAWN_CLEARANCE) return true;
    if (!wrongWay) return false;
    // Behind the spot along the road (where a wrong-way car drives to), in its corridor
    const along = rx * fx + ry * fy;
    const side = rx * -fy + ry * fx;
    return along < 0 && along > -ONCOMING_SPAWN_CLEARANCE && Math.abs(side) < CAR_WIDTH + OBSTACLE_KEEP_GAP;
  };
  for (const body of world.cars.values()) if (blocks(body)) return true;
  for (const obstacle of world.obstacles.values()) if (blocks(obstacle.body)) return true;
  return false;
}

function freeObstacleSlot(world: CarWorld): number {
  const taken = new Set([...world.obstacles.values()].map(o => o.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  return slot;
}

/**
 * Remove obstacles over destroyed ground (with the front at `frontS`), or (safety net) far from
 * the camera. Ids go to `removed` (reused).
 */
function dropLostObstacles(world: CarWorld, frontS: number, removed: string[]): void {
  removed.length = 0;
  const center = cameraCenter(world.road, frontS, scratchCenter);
  for (const [id, obstacle] of world.obstacles) {
    const { x, y } = obstacle.body.position;
    if (isDestroyed(world.road, x, y, frontS)
      || Math.hypot(x - center.x, y - center.y) > OBSTACLE_DESPAWN_DISTANCE) removed.push(id);
  }
  for (const id of removed) removeObstacle(world, id);
}

/** Point the world at this round's road (a client follows `roadSeed`; `getRoad` caches per seed). */
export function useRoadSeed(world: CarWorld, seed: number): void {
  if (world.road.seed !== seed) world.road = getRoad(seed);
}

/** Reused by `stepCarWorld` (single-threaded, never kept). */
const scratchControls: CarControls = { steer: 0, throttle: 0, brake: false, handbrake: false };
const scratchInput: CarInput = { ...NEUTRAL_INPUT };
const scratchRemoved: string[] = [];
const scratchBodies: Matter.Body[] = [];
const scratchPlayers: Matter.Body[] = [];
const NO_INPUTS: ReadonlyMap<string, CarInput> = new Map();
/** Reused by `addCar` / `stepCarRound` (single-threaded, never kept). */
const scratchPose: CarSnapshot = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, av: 0 };

/**
 * Advance the world by one input tick: `subSteps` physics steps of `subDtMs` each, driving every
 * car (`driveCar`) before each step. Cars without an input coast; obstacle cars drive themselves
 * (`obstacleInput`). Dirt caps the top speed: a car driving onto it rolls down to the cap.
 */
export function stepCarWorld(
  world: CarWorld,
  inputs: ReadonlyMap<string, CarInput>,
  subSteps: number,
  subDtMs: number,
): void {
  const { road, frontS } = world;
  const topSpeed = (body: Matter.Body) => isOnRoad(road, body.position.x, body.position.y, frontS)
    ? CAR_MAX_SPEED
    : CAR_MAX_SPEED * DIRT_SPEED_FACTOR;
  // Every car body, for the obstacles to keep their distance from (forces only act in
  // Engine.update, so each one sees the same positions and velocities whatever the order)
  const bodies = scratchBodies;
  bodies.length = 0;
  // The players' cars (eliminated ones are removed), for the obstacles that attack them
  const players = scratchPlayers;
  players.length = 0;
  if (world.obstacles.size > 0) {
    for (const body of world.cars.values()) bodies.push(body), players.push(body);
    for (const obstacle of world.obstacles.values()) bodies.push(obstacle.body);
  }
  for (let i = 0; i < subSteps; i++) {
    for (const [id, body] of world.cars) {
      const input = inputs.get(id);
      const controls = input ? resolveCarControls(body.angle, input, scratchControls) : undefined;
      driveCar(body, controls, topSpeed(body), subDtMs);
    }
    for (const obstacle of world.obstacles.values()) {
      const { body } = obstacle;
      const input = obstacleInput(road, frontS, body, obstacle, bodies, players, scratchInput);
      driveCar(body, resolveCarControls(body.angle, input, scratchControls), topSpeed(body), subDtMs);
    }
    Engine.update(world.engine, subDtMs);
  }
}

/**
 * Advance a round by one input tick, the round having already run `roundTick` ticks. During the
 * countdown (the running start) inputs are ignored: every car drives straight ahead from its spawn
 * at top speed (`runningStartPose`, set directly over the physics step, which only moves the
 * obstacles). After it, the world steps (`stepCarWorld`) and every car now over destroyed ground,
 * or with its center off the camera's view (`isOutOfView`), is removed from the world; their ids
 * are returned (in `eliminated`, reused). Obstacles are removed once over destroyed ground.
 */
export function stepCarRound(
  world: CarWorld,
  inputs: ReadonlyMap<string, CarInput>,
  roundTick: number,
  subSteps: number,
  subDtMs: number,
  eliminated: string[] = [],
): string[] {
  eliminated.length = 0;
  world.frontS = destructionFrontS(roundTick);
  if (roundTick < COUNTDOWN_TICKS) {
    if (world.obstacles.size > 0) stepCarWorld(world, NO_INPUTS, subSteps, subDtMs);
    for (const [id, body] of world.cars) {
      writeCar(body, runningStartPose(world.seats.get(id) ?? 0, world.road.seed, roundTick + 1, scratchPose));
    }
    dropLostObstacles(world, destructionFrontS(roundTick + 1), scratchRemoved);
    return eliminated;
  }

  stepCarWorld(world, inputs, subSteps, subDtMs);
  const frontS = destructionFrontS(roundTick + 1);
  dropLostObstacles(world, frontS, scratchRemoved);
  for (const [id, body] of world.cars) {
    const { x, y } = body.position;
    if (isDestroyed(world.road, x, y, frontS) || isOutOfView(world.road, x, y, frontS)) eliminated.push(id);
  }
  for (const id of eliminated) removeCar(world, id);
  return eliminated;
}

/**
 * Generate the road in play with the front at `frontS` (see road.ts), and drop data of road long
 * gone. Doesn't change any lookup near the cars: the road is the same fixed sequence however far
 * it's generated.
 */
export function maintainRoad(world: CarWorld, frontS: number): void {
  ensureRoadAround(world.road, frontS);
  pruneRoad(world.road, frontS);
}

export function readCar(body: Matter.Body, out: CarSnapshot = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, av: 0 }): CarSnapshot {
  out.x = body.position.x;
  out.y = body.position.y;
  out.angle = body.angle;
  out.vx = body.velocity.x;
  out.vy = body.velocity.y;
  out.av = body.angularVelocity;
  return out;
}

export function writeCar(body: Matter.Body, snapshot: CarSnapshot): void {
  Body.setPosition(body, { x: snapshot.x, y: snapshot.y });
  Body.setAngle(body, snapshot.angle);
  Body.setVelocity(body, { x: snapshot.vx, y: snapshot.vy });
  Body.setAngularVelocity(body, snapshot.av);
}
