import Matter from "matter-js";
import {
  CAR_ACCEL, CAR_AUTO_HANDBRAKE_ANGLE, CAR_AXLE_GRIP_MAX, CAR_AXLE_OFFSET, CAR_BRAKE, CAR_COAST_KEEP,
  CAR_FULL_TURN_SPEED, CAR_HANDBRAKE_KEEP, CAR_HANDBRAKE_REAR_GRIP_MAX, CAR_HANDBRAKE_STEER_BOOST,
  CAR_INPUT_DEADZONE, CAR_LENGTH, CAR_MAX_SPEED, CAR_MAX_WHEEL_ANGLE, CAR_RESTITUTION, CAR_SLIDE_FULL,
  CAR_SLIDE_GRIP_SHARE, CAR_SLIDE_START, CAR_STEER_FULL_ANGLE, CAR_TURN_RATE, CAR_TYRE_GAIN, CAR_WIDTH,
  DIRT_SPEED_FACTOR,
} from "./constants.js";
import { COUNTDOWN_TICKS, destructionFrontS, isDestroyed } from "../car-roquelike/destruction.js";
import { MAP_BLOCKS, SPAWN_POINTS } from "../car-roquelike/map.js";
import { ensureRoad, getRoad, isOnRoad, pruneRoad, ROAD_AHEAD, roadDistanceAt, type Road } from "../car-roquelike/road.js";
import { INPUT_BUTTONS } from "../../constants.js";

const { Bodies, Body, Composite, Engine } = Matter;

/**
 * car-roquelike-mjs-axle's physics, run identically by the server (authoritative) and by the
 * client (prediction + replay). Same API as car-roquelike's physics.ts, but the cars are driven by
 * matter-js with an axle ("bicycle") model: each step every car gets an engine/brake/drag force
 * along its heading, and a capped sideways tyre force at its front axle (wheels turned by the
 * steering) and at its rear axle. Forces off the center also turn the body, so steering, settling
 * and spinning out all come from the tyres; matter integrates them together with the collisions.
 * Deterministic: a function of (world, inputs, step size) only.
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
    // Drag and grip are forces from applyCarForces
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

/** Reused by `applyCarForces` (single-threaded, never kept). */
const scratchControls: CarControls = { steer: 0, throttle: 0, brake: false, handbrake: false };

/** Matter adds `force / mass × dt²` to the velocity (and `r × force / inertia × dt²` to the spin). */
const forceForImpulse = (impulse: number, dtMs: number) => impulse / (dtMs * dtMs);

/** Reused by `applyAxleGrip`. */
const scratchPoint = { x: 0, y: 0 };
const scratchForce = { x: 0, y: 0 };

/**
 * One axle's tyres: at the axle (`along` from the center on the car's axis), the wheels roll along
 * `wheelAngle` (world); their sideways speed there (car velocity + spin × offset) is pushed back
 * toward 0 by a force at that point, capped by grip (less once the axle slides). Because the force
 * is off the center, matter also turns the car with it.
 */
function applyAxleGrip(
  body: Matter.Body,
  along: number,
  wheelAngle: number,
  gripMax: number,
  dtMs: number,
): void {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  // Offset of the axle from the center, and the axle's velocity (v + ω × r)
  const rx = along * cos;
  const ry = along * sin;
  const w = body.angularVelocity;
  const px = body.velocity.x - w * ry;
  const py = body.velocity.y + w * rx;
  // Sideways (to the wheels) unit vector, and the axle's speed along it
  const nx = -Math.sin(wheelAngle);
  const ny = Math.cos(wheelAngle);
  const lateral = px * nx + py * ny;

  // Impulse that would stop the sideways speed at this point: its effective mass there
  const rCrossN = rx * ny - ry * nx;
  const effectiveMass = 1 / (body.inverseMass + rCrossN * rCrossN * body.inverseInertia);
  const sliding = clamp((Math.abs(lateral) - CAR_SLIDE_START) / (CAR_SLIDE_FULL - CAR_SLIDE_START), 0, 1);
  const cap = gripMax * (1 + (CAR_SLIDE_GRIP_SHARE - 1) * sliding) * body.mass;
  const impulse = clamp(-lateral * CAR_TYRE_GAIN * effectiveMass, -cap, cap);

  const force = forceForImpulse(impulse, dtMs);
  scratchPoint.x = body.position.x + rx;
  scratchPoint.y = body.position.y + ry;
  scratchForce.x = force * nx;
  scratchForce.y = force * ny;
  Body.applyForce(body, scratchPoint, scratchForce);
}

/**
 * Axle-model car handling for one physics step (applied before `Engine.update`). The input is
 * turned into controls (`resolveCarControls`); then:
 * - engine/brake/drag along the heading (at the center): the engine pushes only while the forward
 *   speed is below `throttle × top speed` (halved on dirt), drag rolls it down when above, brake
 *   stops it;
 * - front axle: wheels turned by steer × the speed-dependent full lock (see `CAR_TURN_RATE`);
 *   rear axle: straight, and nearly gripless with the handbrake. Each holds its sideways speed
 *   (`applyAxleGrip`), which steers, straightens out, and lets a hit car slide and spin.
 * Without an input (`undefined`) the car coasts with its wheels straight.
 */
export function applyCarForces(
  body: Matter.Body,
  input: CarInput | undefined,
  road: Road,
  frontS: number,
  dtMs: number,
): void {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const forward = body.velocity.x * cos + body.velocity.y * sin;
  const maxSpeed = isOnRoad(road, body.position.x, body.position.y, frontS)
    ? CAR_MAX_SPEED
    : CAR_MAX_SPEED * DIRT_SPEED_FACTOR;

  let steer = 0;
  let handbrake = false;
  // Velocity change wanted this step along the heading
  let forwardAccel: number;
  if (!input) {
    forwardAccel = -forward * (1 - CAR_COAST_KEEP);
  } else {
    const controls = resolveCarControls(body.angle, input, scratchControls);
    steer = controls.steer;
    handbrake = controls.handbrake;
    if (controls.brake) {
      // Brake to a stop (never into reverse)
      forwardAccel = -Math.sign(forward) * Math.min(Math.abs(forward), CAR_BRAKE);
    } else {
      const target = controls.throttle * maxSpeed;
      if (forward < target) {
        // The engine only pushes below the target; pushed backwards (a crash), it recovers harder
        forwardAccel = Math.min(target - forward, forward < 0 ? CAR_BRAKE : CAR_ACCEL);
      } else {
        // Faster than the stick asks for (or than dirt allows): roll down to it
        forwardAccel = -Math.min(forward - target, forward * (1 - CAR_COAST_KEEP));
      }
    }
  }
  if (handbrake) forwardAccel -= (forward + forwardAccel) * (1 - CAR_HANDBRAKE_KEEP);
  const drive = forceForImpulse(forwardAccel * body.mass, dtMs);
  scratchForce.x = drive * cos;
  scratchForce.y = drive * sin;
  Body.applyForce(body, body.position, scratchForce);

  // Full lock: the wheel angle that turns at CAR_TURN_RATE at this speed (wide when slow)
  const wheelbase = 2 * CAR_AXLE_OFFSET;
  const lock = Math.min(
    CAR_MAX_WHEEL_ANGLE,
    Math.atan((CAR_TURN_RATE * wheelbase) / Math.max(Math.abs(forward), CAR_FULL_TURN_SPEED)),
  );
  const wheel = steer * lock * (handbrake ? CAR_HANDBRAKE_STEER_BOOST : 1);
  applyAxleGrip(body, CAR_AXLE_OFFSET, body.angle + wheel, CAR_AXLE_GRIP_MAX, dtMs);
  applyAxleGrip(body, -CAR_AXLE_OFFSET, body.angle, handbrake ? CAR_HANDBRAKE_REAR_GRIP_MAX : CAR_AXLE_GRIP_MAX, dtMs);
}

/**
 * Advance the world by one input tick: `subSteps` physics steps of `subDtMs` each, applying every
 * car's driving forces before each step (matter clears them after it). Cars without an input coast
 * (see `applyCarForces`).
 */
export function stepCarWorld(
  world: CarWorld,
  inputs: ReadonlyMap<string, CarInput>,
  subSteps: number,
  subDtMs: number,
): void {
  for (let i = 0; i < subSteps; i++) {
    for (const [id, body] of world.cars) {
      applyCarForces(body, inputs.get(id), world.road, world.frontS, subDtMs);
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
 * the front, and drop data of road long gone (see car-roquelike's road.ts).
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
