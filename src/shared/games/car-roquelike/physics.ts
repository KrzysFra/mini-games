import Matter from "matter-js";
import { CAR_LENGTH, CAR_MAX_SPEED, CAR_RESTITUTION, CAR_WIDTH, DIRT_SPEED_FACTOR } from "./constants.js";
import { resolveCarControls, type CarControls, type CarInput } from "./controls.js";
import { COUNTDOWN_TICKS, destructionFrontS, isDestroyed } from "./destruction.js";
import { driveCar } from "./handling.js";
import { MAP_BLOCKS, SPAWN_POINTS } from "./map.js";
import { ensureRoad, getRoad, isOnRoad, pruneRoad, ROAD_AHEAD, roadDistanceAt, type Road } from "./road.js";

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

export interface CarWorld {
  engine: Matter.Engine;
  /** Car bodies by player id (sessionId). */
  cars: Map<string, Matter.Body>;
  /** The road: decides where cars are on dirt, and the destruction. Set per round. */
  road: Road;
  /** Where the destruction front is (`stepCarRound` sets it): road far behind it is gone. */
  frontS: number;
}

/** The road a world starts with until the round sets its own. */
export const DEFAULT_ROAD_SEED = 1;

export function createCarWorld(road: Road = getRoad(DEFAULT_ROAD_SEED)): CarWorld {
  const engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
  const blocks = MAP_BLOCKS.map(b => Bodies.rectangle(b.x, b.y, b.width, b.height, { isStatic: true }));
  Composite.add(engine.world, blocks);
  return { engine, cars: new Map(), road, frontS: 0 };
}

export function destroyCarWorld(world: CarWorld): void {
  Composite.clear(world.engine.world, false, true);
  Engine.clear(world.engine);
  world.cars.clear();
}

/** Add a car at a seat's spawn point (or set it from a snapshot); replaces an existing one. */
export function addCar(world: CarWorld, id: string, spawnIndex: number, snapshot?: CarSnapshot): Matter.Body {
  removeCar(world, id);
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length];
  const body = Bodies.rectangle(spawn.x, spawn.y, CAR_LENGTH, CAR_WIDTH, {
    angle: spawn.angle,
    // Drag, grip and top speed are forces from driveCar
    frictionAir: 0,
    friction: 0.05,
    restitution: CAR_RESTITUTION,
    label: `car:${id}`,
  });
  if (snapshot) writeCar(body, snapshot);
  Composite.add(world.engine.world, body);
  world.cars.set(id, body);
  return body;
}

export function removeCar(world: CarWorld, id: string): void {
  const body = world.cars.get(id);
  if (!body) return;
  Composite.remove(world.engine.world, body);
  world.cars.delete(id);
}

/** Point the world at this round's road (a client follows `roadSeed`; `getRoad` caches per seed). */
export function useRoadSeed(world: CarWorld, seed: number): void {
  if (world.road.seed !== seed) world.road = getRoad(seed);
}

/** Reused by `stepCarWorld` (single-threaded, never kept). */
const scratchControls: CarControls = { steer: 0, throttle: 0, brake: false, handbrake: false };

/**
 * Advance the world by one input tick: `subSteps` physics steps of `subDtMs` each, driving every
 * car (`driveCar`) before each step. Cars without an input coast. Dirt caps the top speed: a car
 * driving onto it rolls down to the cap.
 */
export function stepCarWorld(
  world: CarWorld,
  inputs: ReadonlyMap<string, CarInput>,
  subSteps: number,
  subDtMs: number,
): void {
  const { road, frontS } = world;
  for (let i = 0; i < subSteps; i++) {
    for (const [id, body] of world.cars) {
      const input = inputs.get(id);
      const controls = input ? resolveCarControls(body.angle, input, scratchControls) : undefined;
      const maxSpeed = isOnRoad(road, body.position.x, body.position.y, frontS)
        ? CAR_MAX_SPEED
        : CAR_MAX_SPEED * DIRT_SPEED_FACTOR;
      driveCar(body, controls, maxSpeed, subDtMs);
    }
    Engine.update(world.engine, subDtMs);
  }
}

/**
 * Advance a round by one input tick, the round having already run `roundTick` ticks. During the
 * countdown nothing moves. After it, the world steps (`stepCarWorld`) and every car now over
 * destroyed ground is removed from the world; their ids are returned (in `eliminated`, reused).
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
  if (roundTick < COUNTDOWN_TICKS) return eliminated;

  world.frontS = destructionFrontS(roundTick);
  stepCarWorld(world, inputs, subSteps, subDtMs);
  const frontS = destructionFrontS(roundTick + 1);
  for (const [id, body] of world.cars) {
    if (isDestroyed(world.road, body.position.x, body.position.y, frontS)) eliminated.push(id);
  }
  for (const id of eliminated) removeCar(world, id);
  return eliminated;
}

/**
 * Keep the road generated `ROAD_AHEAD` beyond the leading car (by distance along the road) and
 * the front, and drop data of road long gone. Doesn't change any lookup near the cars: the road is
 * the same fixed sequence however far it's generated (see road.ts).
 */
export function maintainRoad(world: CarWorld, frontS: number): void {
  let lead = frontS;
  for (const body of world.cars.values()) {
    lead = Math.max(lead, roadDistanceAt(world.road, body.position.x, body.position.y, frontS));
  }
  ensureRoad(world.road, lead + ROAD_AHEAD);
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
