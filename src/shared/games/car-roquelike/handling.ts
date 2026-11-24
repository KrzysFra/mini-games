import Matter from "matter-js";
import {
  CAR_ACCEL, CAR_BRAKE, CAR_COAST_KEEP, CAR_FULL_TURN_SPEED, CAR_HANDBRAKE_KEEP, CAR_HANDBRAKE_TURN_BOOST,
  CAR_TURN_RATE,
} from "./constants.js";
import { clamp, type CarControls } from "./controls.js";

const { Body } = Matter;

/**
 * How a car handles: an axle ("bicycle") model driven by matter-js forces. Per physics step, an
 * engine/brake/drag force along the heading at the center (`forwardSpeedChange`), and a capped
 * sideways tyre force at the front axle (wheels turned by the steering) and the rear axle
 * (straight; nearly gripless with the handbrake). Forces off the center turn the body, so steering,
 * settling and spinning out all come from the tyres; matter integrates them with the collisions.
 *
 * Accelerations are "velocity change per physics step" (see constants.ts).
 */

/** Front and rear axle distance from the car's center, along its length. */
export const CAR_AXLE_OFFSET = 14;
const WHEELBASE = 2 * CAR_AXLE_OFFSET;

/**
 * Front wheel angle: steer × the largest angle that gives the car a turn rate of `CAR_TURN_RATE`
 * at its current speed (the steady turn rate is speed × tan(angle) / wheelbase; below
 * `CAR_FULL_TURN_SPEED` it stops growing), never more than `CAR_MAX_WHEEL_ANGLE`. So, like a
 * speed-sensitive steering rack, full lock is wide when slow and a few degrees at top speed.
 * The handbrake widens it by `CAR_HANDBRAKE_TURN_BOOST`.
 */
export const CAR_MAX_WHEEL_ANGLE = (35 * Math.PI) / 180;

/**
 * Tyre grip, per axle: a sideways force at the axle that cancels `CAR_TYRE_GAIN` of the axle's
 * sideways speed per step, capped so one axle changes the car's speed by at most
 * `CAR_AXLE_GRIP_MAX` per step (both together: twice that; cornering at top speed needs ≈ 0.85).
 */
export const CAR_TYRE_GAIN = 0.5;
export const CAR_AXLE_GRIP_MAX = 0.6;
/** Rear axle grip cap with the handbrake on (locked rear wheels slide: the tail swings out). */
export const CAR_HANDBRAKE_REAR_GRIP_MAX = 0.08;

/**
 * Sliding tyres hold less than gripping ones (kinetic < static friction): between these sideways
 * speeds at an axle, its grip cap blends down to `CAR_SLIDE_GRIP_SHARE` of normal. Normal
 * cornering stays below the start; a hit pushes axles past it, so the car slides and spins until
 * it slows its slide. From the velocity alone, so there's no extra state to replicate.
 */
export const CAR_SLIDE_START = 1.5;
export const CAR_SLIDE_FULL = 4;
export const CAR_SLIDE_GRIP_SHARE = 0.35;

/**
 * The change of forward speed one step of the controls asks for: brake to a stop (never into
 * reverse); with throttle, accelerate toward `throttle × maxSpeed` (shoved backwards, recover at
 * braking strength) or roll down to it when faster; coast without controls. The handbrake bleeds
 * speed on top.
 */
function forwardSpeedChange(forward: number, controls: CarControls | undefined, maxSpeed: number): number {
  let change: number;
  if (!controls) {
    change = -forward * (1 - CAR_COAST_KEEP);
  } else if (controls.brake) {
    change = -Math.sign(forward) * Math.min(Math.abs(forward), CAR_BRAKE);
  } else {
    const target = controls.throttle * maxSpeed;
    change = forward < target
      ? Math.min(target - forward, forward < 0 ? CAR_BRAKE : CAR_ACCEL)
      : -Math.min(forward - target, forward * (1 - CAR_COAST_KEEP));
  }
  if (controls?.handbrake) change -= (forward + change) * (1 - CAR_HANDBRAKE_KEEP);
  return change;
}

/**
 * The force that changes a body's momentum by `impulse` over the next `Engine.update`: matter adds
 * `force / mass × dt²` to the velocity (and `r × force / inertia × dt²` to the spin), then clears it.
 */
const forceForImpulse = (impulse: number, dtMs: number) => impulse / (dtMs * dtMs);

/** Reused by `applyAxleGrip` / `driveCar` (single-threaded, never kept). */
const scratchPoint = { x: 0, y: 0 };
const scratchForce = { x: 0, y: 0 };

/**
 * One axle's tyres: at the axle (`along` from the center on the car's axis), the wheels roll along
 * `wheelAngle` (world); their sideways speed there (car velocity + spin × offset) is pushed back
 * toward 0 by a force at that point, capped by grip (less once the axle slides). Because the force
 * is off the center, matter also turns the car with it.
 */
function applyAxleGrip(
  body: Matter.Body, cos: number, sin: number, along: number, wheelAngle: number, gripMax: number, dtMs: number,
): void {
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
  const force = forceForImpulse(clamp(-lateral * CAR_TYRE_GAIN * effectiveMass, -cap, cap), dtMs);

  scratchPoint.x = body.position.x + rx;
  scratchPoint.y = body.position.y + ry;
  scratchForce.x = force * nx;
  scratchForce.y = force * ny;
  Body.applyForce(body, scratchPoint, scratchForce);
}

/**
 * Drive one car for one physics step (call right before `Engine.update`). `controls` is
 * `undefined` without an input (other players' cars between server updates): the car coasts with
 * its wheels straight. `maxSpeed` is the top speed where the car is (lower on dirt).
 */
export function driveCar(body: Matter.Body, controls: CarControls | undefined, maxSpeed: number, dtMs: number): void {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const forward = body.velocity.x * cos + body.velocity.y * sin;
  const handbrake = controls?.handbrake ?? false;

  const drive = forceForImpulse(forwardSpeedChange(forward, controls, maxSpeed) * body.mass, dtMs);
  scratchForce.x = drive * cos;
  scratchForce.y = drive * sin;
  Body.applyForce(body, body.position, scratchForce);

  // Full lock: the wheel angle that turns at CAR_TURN_RATE at this speed (wide when slow)
  const lock = Math.min(
    CAR_MAX_WHEEL_ANGLE,
    Math.atan((CAR_TURN_RATE * WHEELBASE) / Math.max(Math.abs(forward), CAR_FULL_TURN_SPEED)),
  );
  const wheel = (controls?.steer ?? 0) * lock * (handbrake ? CAR_HANDBRAKE_TURN_BOOST : 1);
  const rearGrip = handbrake ? CAR_HANDBRAKE_REAR_GRIP_MAX : CAR_AXLE_GRIP_MAX;
  applyAxleGrip(body, cos, sin, CAR_AXLE_OFFSET, body.angle + wheel, CAR_AXLE_GRIP_MAX, dtMs);
  applyAxleGrip(body, cos, sin, -CAR_AXLE_OFFSET, body.angle, rearGrip, dtMs);
}
