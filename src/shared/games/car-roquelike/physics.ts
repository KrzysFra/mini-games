import Matter from "matter-js";
import {
  CAR_ACCEL, CAR_BRAKE, CAR_COAST_KEEP, CAR_FULL_TURN_SPEED, CAR_GRIP_KEEP, CAR_HANDBRAKE_GRIP_KEEP,
  CAR_HANDBRAKE_KEEP, CAR_LENGTH, CAR_MAX_REVERSE_SPEED, CAR_MAX_SPEED, CAR_RESTITUTION,
  CAR_AUTO_HANDBRAKE_ANGLE, CAR_HANDBRAKE_TURN_BOOST, CAR_INPUT_DEADZONE, CAR_SLIP_GRIP_KEEP, CAR_SLIP_IMPACT_MIN,
  CAR_SLIP_PER_IMPACT, CAR_SLIP_RECOVERY, CAR_SLIP_STEER_LOSS, CAR_STEER_AUTHORITY,
  CAR_STEER_FULL_ANGLE, CAR_TURN_RATE, CAR_WIDTH, DIRT_SPEED_FACTOR,
} from "./constants.js";
import { COUNTDOWN_TICKS, destructionFrontS, isDestroyed } from "./destruction.js";
import { MAP_BLOCKS, SPAWN_POINTS } from "./map.js";
import { ensureRoad, getRoad, isOnRoad, pruneRoad, ROAD_AHEAD, roadDistanceAt, type Road } from "./road.js";
import { INPUT_BUTTONS } from "../../constants.js";

const { Bodies, Body, Composite, Engine } = Matter;

/**
 * car-roquelike's physics, run identically by the server (authoritative) and by the client
 * (prediction + replay). Deterministic: a function of (world, inputs, step size) only — no
 * clocks, randomness, or outside reads.
 */

/**
 * One player's controls for a tick: the direction they want to drive in, in world space (+x right,
 * +y down; the camera is north-up, so it's also the stick/screen direction). Its length (0..1) is
 * the throttle; a (near) zero vector means brake. `handbrake` forces the handbrake on.
 */
export interface CarInput {
  dirX: number;
  dirY: number;
  handbrake: boolean;
}

export const NEUTRAL_INPUT: CarInput = { dirX: 0, dirY: 0, handbrake: false };

/** What the car does with a `CarInput`, given its heading. */
export interface CarControls {
  /** -1 (left) .. 1 (right). */
  steer: number;
  /** 0 .. 1 forward drive. */
  throttle: number;
  brake: boolean;
  handbrake: boolean;
}

/** Wrap an angle to -π..π. */
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * Turn a wanted direction into car controls: steer toward it (harder the further off it is),
 * throttle by the stick's deflection, handbrake when more than `CAR_AUTO_HANDBRAKE_ANGLE` off,
 * brake when the stick is centered.
 */
export function resolveCarControls(heading: number, input: CarInput, out: CarControls = {
  steer: 0, throttle: 0, brake: false, handbrake: false,
}): CarControls {
  const magnitude = Math.min(1, Math.hypot(input.dirX, input.dirY));
  if (!(magnitude >= CAR_INPUT_DEADZONE)) {
    out.steer = 0;
    out.throttle = 0;
    out.brake = true;
    out.handbrake = input.handbrake;
    return out;
  }

  // Positive = the wanted direction is clockwise on screen (y down) = steer right
  const offset = wrapAngle(Math.atan2(input.dirY, input.dirX) - heading);
  out.steer = clamp(offset / CAR_STEER_FULL_ANGLE, -1, 1);
  out.throttle = magnitude;
  out.brake = false;
  out.handbrake = input.handbrake || Math.abs(offset) > CAR_AUTO_HANDBRAKE_ANGLE;
  return out;
}

/** The wire input every mini-game shares (the server's `GameInput`), structurally. */
export interface GameInputLike {
  x: number;
  y: number;
  buttons: number;
}

/** Map the shared wire input to car input: (x, y) = wanted direction, action button = handbrake. */
export const toCarInput = (input: GameInputLike, out: CarInput = { ...NEUTRAL_INPUT }): CarInput => {
  out.dirX = input.x;
  out.dirY = input.y;
  out.handbrake = (input.buttons & INPUT_BUTTONS.ACTION) !== 0;
  return out;
};

/** A car's full dynamic state as plain numbers (what the server replicates). */
export interface CarSnapshot {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  av: number;
  /** Loss of grip after a hit, 0..1 (see `CAR_SLIP_IMPACT_MIN`). Missing = 0. */
  slip?: number;
}

/** A car's slip (loss of grip after a hit, 0..1), kept on its body. */
export const carSlip = (body: Matter.Body): number => (body.plugin as { slip?: number }).slip ?? 0;
const setCarSlip = (body: Matter.Body, slip: number) => { (body.plugin as { slip?: number }).slip = slip; };

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
    // Drag, grip and top speed are handled in applyCarInput
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

const clamp = (value: number, min: number, max: number) =>
  (value < min ? min : value > max ? max : value);

/** Reused by `applyCarInput` (single-threaded, never kept). */
const scratchControls: CarControls = { steer: 0, throttle: 0, brake: false, handbrake: false };

/**
 * Arcade top-down car handling for one physics step. The input is turned into controls
 * (`resolveCarControls`); then the forward speed approaches `throttle × CAR_MAX_SPEED` (or brakes
 * to a stop), most sideways speed is removed (grip; much less with the handbrake), and steering
 * scales with forward speed. Without an input (`undefined`, e.g. other players' cars between
 * server updates on the client) the car coasts straight.
 */
export function applyCarInput(body: Matter.Body, input: CarInput | undefined, road: Road, frontS: number): void {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const vx = body.velocity.x;
  const vy = body.velocity.y;
  // Dirt caps the top speed; a car driving onto it rolls down to the cap (see below)
  const maxSpeed = isOnRoad(road, body.position.x, body.position.y, frontS)
    ? CAR_MAX_SPEED
    : CAR_MAX_SPEED * DIRT_SPEED_FACTOR;

  // Velocity in the car's frame: forward (+x local) and sideways (+y local)
  let forward = vx * cos + vy * sin;
  let side = -vx * sin + vy * cos;

  const slip = carSlip(body);
  let steer = 0;
  let handbrake = false;
  if (!input) {
    forward *= CAR_COAST_KEEP;
  } else {
    const controls = resolveCarControls(body.angle, input, scratchControls);
    steer = controls.steer;
    handbrake = controls.handbrake;

    if (controls.brake) {
      // Brake to a stop (never into reverse)
      forward = forward > 0 ? Math.max(0, forward - CAR_BRAKE) : Math.min(0, forward + CAR_BRAKE);
    } else {
      const target = controls.throttle * maxSpeed;
      if (forward < target) {
        // Pushed backwards (a crash): recover at braking strength
        forward = Math.min(target, forward + (forward < 0 ? CAR_BRAKE : CAR_ACCEL) * (1 - slip));
      } else {
        // Faster than the stick asks for: roll down to it
        forward = Math.max(target, forward * CAR_COAST_KEEP);
      }
    }
  }
  if (handbrake) forward *= CAR_HANDBRAKE_KEEP;
  forward = clamp(forward, -CAR_MAX_REVERSE_SPEED, CAR_MAX_SPEED);

  // Slipping after a hit: the car slides on with the shove
  const gripKeep = handbrake ? CAR_HANDBRAKE_GRIP_KEEP : CAR_GRIP_KEEP;
  side *= gripKeep + (Math.max(gripKeep, CAR_SLIP_GRIP_KEEP) - gripKeep) * slip;

  Body.setVelocity(body, { x: forward * cos - side * sin, y: forward * sin + side * cos });

  // No turning on the spot; handbrake turns swing around faster
  const speedFactor = clamp(forward / CAR_FULL_TURN_SPEED, -1, 1);
  const turnRate = CAR_TURN_RATE * (handbrake ? CAR_HANDBRAKE_TURN_BOOST : 1);
  const targetSpin = steer * turnRate * speedFactor;
  // ... and steering barely holds the spin from the hit
  const authority = CAR_STEER_AUTHORITY * (1 - CAR_SLIP_STEER_LOSS * slip);
  const spin = body.angularVelocity + (targetSpin - body.angularVelocity) * authority;
  Body.setAngularVelocity(body, spin);
  if (slip > 0) setCarSlip(body, Math.max(0, slip - CAR_SLIP_RECOVERY));
}

/** Reused by `stepCarWorld`: each car's velocity before a physics update (vx, vy, av per car). */
const before: number[] = [];

/**
 * Advance the world by one input tick: `subSteps` physics steps of `subDtMs` each, applying every
 * car's input before each step (forces and velocity changes only last one step). Cars without an
 * input coast straight (see `applyCarInput`).
 */
export function stepCarWorld(
  world: CarWorld,
  inputs: ReadonlyMap<string, CarInput>,
  subSteps: number,
  subDtMs: number,
): void {
  for (let i = 0; i < subSteps; i++) {
    for (const [id, body] of world.cars) {
      applyCarInput(body, inputs.get(id), world.road, world.frontS);
    }
    // The velocities the handling set: whatever changes them during the update is a contact
    let n = 0;
    for (const body of world.cars.values()) {
      before[n++] = body.velocity.x;
      before[n++] = body.velocity.y;
      before[n++] = body.angularVelocity;
    }
    Engine.update(world.engine, subDtMs);
    n = 0;
    for (const body of world.cars.values()) {
      const dv = Math.hypot(body.velocity.x - before[n], body.velocity.y - before[n + 1]);
      const dav = Math.abs(body.angularVelocity - before[n + 2]);
      n += 3;
      const impact = dv + dav * (CAR_LENGTH / 2);
      if (impact > CAR_SLIP_IMPACT_MIN) {
        setCarSlip(body, Math.max(carSlip(body), Math.min(1, (impact - CAR_SLIP_IMPACT_MIN) * CAR_SLIP_PER_IMPACT)));
      }
    }
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

export function readCar(body: Matter.Body, out: CarSnapshot = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, av: 0, slip: 0 }): CarSnapshot {
  out.x = body.position.x;
  out.y = body.position.y;
  out.angle = body.angle;
  out.vx = body.velocity.x;
  out.vy = body.velocity.y;
  out.av = body.angularVelocity;
  out.slip = carSlip(body);
  return out;
}

export function writeCar(body: Matter.Body, snapshot: CarSnapshot): void {
  Body.setPosition(body, { x: snapshot.x, y: snapshot.y });
  Body.setAngle(body, snapshot.angle);
  Body.setVelocity(body, { x: snapshot.vx, y: snapshot.vy });
  Body.setAngularVelocity(body, snapshot.av);
  setCarSlip(body, snapshot.slip ?? 0);
}
