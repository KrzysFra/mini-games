/**
 * Tuning for car-roquelike-mjs-torque (the force-driven clone of car-roquelike), shared by the
 * server simulation and the client's prediction.
 *
 * The world, the car's size and top speed are car-roquelike's (road, destruction and map are
 * shared, and the destruction speed depends on the top speed); only the handling differs.
 *
 * Units: world pixels. Velocities are matter.js units — pixels per 1000/60 ms (`PHYSICS_STEP_MS`).
 * Accelerations are "velocity change per physics step"; physics.ts turns them into matter forces
 * and torques.
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

/**
 * Sideways grip: a force against the car's sideways speed, `side × CAR_GRIP_GAIN` per step, but at
 * most `CAR_GRIP_MAX` (`CAR_HANDBRAKE_GRIP_MAX` with the handbrake). Cornering at top speed needs
 * about speed × turn rate ≈ 0.85; a hit shoving harder than the cap makes the car slide.
 */
export const CAR_GRIP_GAIN = 0.9;
export const CAR_GRIP_MAX = 1.2;
export const CAR_HANDBRAKE_GRIP_MAX = 0.15;

/**
 * Sliding tyres hold less than gripping ones (kinetic < static friction): between these sideways
 * speeds the grip cap blends from `CAR_GRIP_MAX` down to `CAR_SLIDE_GRIP_MAX`, and the steering
 * torque cap from `CAR_STEER_MAX_ACCEL` down to `CAR_SLIDE_STEER_MAX_ACCEL`. Normal cornering stays
 * below the start; a hit pushes the car past it, so it slides and spins until it slows its slide.
 * Derived from the velocity alone, so there's no extra state to replicate.
 */
export const CAR_SLIDE_START = 1.5;
export const CAR_SLIDE_FULL = 4;
export const CAR_SLIDE_GRIP_MAX = 0.3;

/** Wanted spin (radians per step) at full steer once at `CAR_FULL_TURN_SPEED` or faster. */
export const CAR_TURN_RATE = 0.06;
/** Below this forward speed, the wanted spin is scaled down (no turning on the spot). */
export const CAR_FULL_TURN_SPEED = 4;
/** Turn-rate multiplier while the handbrake is on, so handbrake turns swing the car around. */
export const CAR_HANDBRAKE_TURN_BOOST = 1.5;
/**
 * Steering torque: angular acceleration `(wanted spin − spin) × CAR_STEER_GAIN` per step, at most
 * `CAR_STEER_MAX_ACCEL` — so spin from a hit outlasts the steering for a moment.
 */
export const CAR_STEER_GAIN = 0.35;
export const CAR_STEER_MAX_ACCEL = 0.01;
export const CAR_SLIDE_STEER_MAX_ACCEL = 0.002;
