/**
 * Tuning for car-roquelike, shared by the server simulation and the client's prediction.
 *
 * Units: world pixels. Velocities are matter.js units — pixels per 1000/60 ms (`PHYSICS_STEP_MS`)
 * — which is also the physics step, so one step moves a body by exactly its velocity.
 */

/** Physics sub-steps per input tick (`TICK_RATE`): 30 inputs/s × 2 = physics at 60 Hz. */
export const PHYSICS_SUBSTEPS = 2;
/** Matter's native step; `1000 / TICK_RATE / PHYSICS_SUBSTEPS` must equal it. */
export const PHYSICS_STEP_MS = 1000 / 60;

export const ARENA_WIDTH = 3200;
export const ARENA_HEIGHT = 2400;
export const WALL_THICKNESS = 80;

/** A car is a rectangle that faces +x at angle 0 (length along x). */
export const CAR_LENGTH = 40;
export const CAR_WIDTH = 20;

/** Forward speed gained per physics step at full throttle. */
export const CAR_ACCEL = 0.10;
/** Deceleration per step when braking (stick centered). */
export const CAR_BRAKE = 0.6;
/** Top speed forwards / backwards, per step. */
export const CAR_MAX_SPEED = 14;
export const CAR_MAX_REVERSE_SPEED = 5;
/** Share of forward speed kept per step while coasting (rolling resistance). */
export const CAR_COAST_KEEP = 0.985;

/** Share of sideways speed kept per step: low = grippy, high = drifty (handbrake). */
export const CAR_GRIP_KEEP = 0.1;
export const CAR_HANDBRAKE_GRIP_KEEP = 0.9;
/** Share of forward speed kept per step with the handbrake on. */
export const CAR_HANDBRAKE_KEEP = 0.97;

/** Angular velocity (radians per step) at full steer once at `CAR_FULL_TURN_SPEED` or faster. */
export const CAR_TURN_RATE = 0.06;
/** Below this forward speed, steering is scaled down (no turning on the spot). */
export const CAR_FULL_TURN_SPEED = 4;

/**
 * Directional steering: the player gives the direction to drive in and the car steers toward it.
 * Steering grows with the angle between that direction and the car's heading, reaching full
 * steer at this angle (smaller = more aggressive).
 */
export const CAR_STEER_FULL_ANGLE = (60 * Math.PI) / 180;
/** Beyond this angle off the wanted direction, the handbrake comes on by itself (handbrake turn). */
export const CAR_AUTO_HANDBRAKE_ANGLE = (80 * Math.PI) / 180;
/** Turn-rate multiplier while the handbrake is on, so handbrake turns swing the car around. */
export const CAR_HANDBRAKE_TURN_BOOST = 1.5;
/** Directions shorter than this count as "stick centered" (the car brakes). */
export const CAR_INPUT_DEADZONE = 0.05;
/**
 * How strongly steering takes over the angular velocity per step (0..1). Below 1, part of the
 * spin from a crash survives, so hits knock the car around.
 */
export const CAR_STEER_AUTHORITY = 0.35;

/** Car-vs-car / car-vs-wall bounce. */
export const CAR_RESTITUTION = 0.3;
