/**
 * Tuning for car-roquelike-mjs-axle (the axle-model clone of car-roquelike), shared by the server
 * simulation and the client's prediction.
 *
 * The world, the car's size and top speed are car-roquelike's (road, destruction and map are
 * shared, and the destruction speed depends on the top speed); only the handling differs.
 *
 * Units: world pixels. Velocities are matter.js units — pixels per 1000/60 ms (`PHYSICS_STEP_MS`).
 * Accelerations are "velocity change per physics step"; physics.ts turns them into matter forces.
 */
export {
  PHYSICS_SUBSTEPS, PHYSICS_STEP_MS, ROAD_WIDTH, DIRT_SPEED_FACTOR, CAR_LENGTH, CAR_WIDTH, CAR_MAX_SPEED,
  CAR_RESTITUTION, CAR_STEER_FULL_ANGLE, CAR_AUTO_HANDBRAKE_ANGLE, CAR_INPUT_DEADZONE,
} from "../car-roquelike/constants.js";

/** Engine: forward speed gained per step at full throttle, only while below the target speed. */
export const CAR_ACCEL = 0.10;
/** Brake (stick centered) deceleration per step; also how fast a car shoved backwards recovers. */
export const CAR_BRAKE = 0.6;
/** Share of forward speed kept per step while coasting or above the target speed (rolling drag). */
export const CAR_COAST_KEEP = 0.985;
/** Share of forward speed kept per step with the handbrake on. */
export const CAR_HANDBRAKE_KEEP = 0.97;

/** Front and rear axle distance from the car's center, along its length. */
export const CAR_AXLE_OFFSET = 14;

/**
 * Front wheel angle: steer (from `resolveCarControls`, -1..1) × the largest angle that gives the
 * car a turn rate of `CAR_TURN_RATE` at its current speed (radians per step; the steady turn rate
 * is speed × tan(angle) / wheelbase), never more than `CAR_MAX_WHEEL_ANGLE`. So, like a
 * speed-sensitive steering rack, full lock is wide when slow and a few degrees at top speed.
 */
export const CAR_TURN_RATE = 0.06;
/** Below this forward speed the wheel angle stops growing (`CAR_MAX_WHEEL_ANGLE` reached). */
export const CAR_FULL_TURN_SPEED = 4;
export const CAR_MAX_WHEEL_ANGLE = (35 * Math.PI) / 180;
/** Wheel-angle multiplier with the handbrake on, so handbrake turns swing the car around. */
export const CAR_HANDBRAKE_STEER_BOOST = 1.5;

/**
 * Tyre grip, per axle: a sideways force at the axle that cancels `CAR_TYRE_GAIN` of the axle's
 * sideways speed per step, capped so one axle changes the car's speed by at most
 * `CAR_AXLE_GRIP_MAX` per step (both together: twice that; cornering at top speed needs ≈ 0.85).
 * Forces at the axles also turn the car: the front wheels steer it, the rear keeps it straight.
 */
export const CAR_TYRE_GAIN = 0.5;
export const CAR_AXLE_GRIP_MAX = 0.6;
/** Rear axle grip cap with the handbrake on (locked rear wheels slide: the tail swings out). */
export const CAR_HANDBRAKE_REAR_GRIP_MAX = 0.08;

/**
 * Sliding tyres hold less than gripping ones (kinetic < static friction): between these sideways
 * speeds at an axle, its grip cap blends down to `CAR_SLIDE_GRIP_SHARE` of normal. A hit pushes
 * axles past it, so the car slides and spins until it slows its slide. Per axle, from the velocity
 * alone (no extra state).
 */
export const CAR_SLIDE_START = 1.5;
export const CAR_SLIDE_FULL = 4;
export const CAR_SLIDE_GRIP_SHARE = 0.35;
