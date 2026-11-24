/**
 * Tuning for car-roquelike, shared by the server simulation and the client's prediction. The
 * tyre tuning is in handling.ts.
 *
 * Units: world pixels. Velocities are matter.js units — pixels per 1000/60 ms (`PHYSICS_STEP_MS`)
 * — which is also the physics step, so one step moves a body by exactly its velocity.
 * Accelerations are "velocity change per physics step".
 */

import { TICK_RATE } from "../../constants.js";

/** Physics sub-steps per input tick (`TICK_RATE`): 30 inputs/s × 2 = physics at 60 Hz. */
export const PHYSICS_SUBSTEPS = 2;
/** Matter's native step; `1000 / TICK_RATE / PHYSICS_SUBSTEPS` must equal it. */
export const PHYSICS_STEP_MS = 1000 / 60;

/**
 * The world: one randomly generated, endless road (`road.ts`), starting at the origin heading
 * north. Everything else, in every direction, is dirt.
 */
export const ROAD_WIDTH = 400;
/** Share of the top speed a car keeps on dirt. */
export const DIRT_SPEED_FACTOR = 0.5;
/** The camera is on the road this far (along it) ahead of the destruction front (see camera.ts). */
export const CAMERA_AHEAD_OF_FRONT = 1000;
/** The game's logical screen size (`main.ts`; `Scale.FIT` keeps it whatever the window). */
export const SCREEN_WIDTH = 1920;
export const SCREEN_HEIGHT = 1080;
/**
 * The camera's fixed zoom. At 0.45 the view reaches 1200 above and below its center, so the spawn
 * grid (640..740 below the camera at the start, just ahead of the front) is in the lower part of it.
 */
export const CAMERA_ZOOM = 0.45;
/** Half the world area the camera shows. */
export const VIEW_HALF_WIDTH = SCREEN_WIDTH / 2 / CAMERA_ZOOM;
export const VIEW_HALF_HEIGHT = SCREEN_HEIGHT / 2 / CAMERA_ZOOM;

/** A car is a rectangle that faces +x at angle 0 (length along x). */
export const CAR_LENGTH = 40;
export const CAR_WIDTH = 20;
/** Car-vs-car / car-vs-wall bounce. */
export const CAR_RESTITUTION = 0.3;

/**
 * The game's speed: how far the destruction front, and with it the camera, moves along the road
 * per minute. Cars' top speed is derived from it (`CAR_MAX_SPEED`).
 */
export const CAMERA_SPEED_PER_MINUTE = 50000;
/** The destruction front's speed as a share of a car's top speed, so cars can pull away from it. */
export const DESTRUCTION_SPEED_FACTOR = 0.95;
/** Top forward speed, per step: the front's speed (`CAMERA_SPEED_PER_MINUTE`) / `DESTRUCTION_SPEED_FACTOR`. */
export const CAR_MAX_SPEED =
  CAMERA_SPEED_PER_MINUTE / (60000 / PHYSICS_STEP_MS) / DESTRUCTION_SPEED_FACTOR;
/**
 * Ticks (`TICK_RATE`) of countdown at the start of a round: the running start. Every car drives
 * straight north up the first straight at top speed, out of the players' control, and the
 * destruction front (with the camera) follows at the same speed (see destruction.ts).
 */
export const COUNTDOWN_TICKS = 4 * TICK_RATE;
/**
 * Once only one car is left in a round that had two or more, the winner's text ("<name> has
 * won!!") shows this many ticks, then the world fades to black for `WIN_FADE_TICKS` and the
 * round restarts.
 */
export const WIN_TEXT_TICKS = 5 * TICK_RATE;
export const WIN_FADE_TICKS = 1 * TICK_RATE;
/** How far up the road the cars (and the front) get during the countdown. */
export const RUNNING_START_DISTANCE = COUNTDOWN_TICKS * PHYSICS_SUBSTEPS * CAR_MAX_SPEED;

/** Engine: forward speed gained per step at full throttle, while below the target speed. */
export const CAR_ACCEL = 0.10;
/** Brake (stick centered) deceleration per step; also how fast a car shoved backwards recovers. */
export const CAR_BRAKE = 0.6;
/** Share of forward speed kept per step while coasting or above the target speed (rolling drag). */
export const CAR_COAST_KEEP = 0.985;
/** Share of forward speed kept per step with the handbrake on. */
export const CAR_HANDBRAKE_KEEP = 0.97;

/** Turn rate (radians per step) at full steer (see `CAR_MAX_WHEEL_ANGLE` in handling.ts). */
export const CAR_TURN_RATE = 0.06;
/** Below this forward speed, the full-lock wheel angle stops growing. */
export const CAR_FULL_TURN_SPEED = 4;
/** Wheel-angle multiplier while the handbrake is on, so handbrake turns swing the car around. */
export const CAR_HANDBRAKE_TURN_BOOST = 1.5;

/**
 * Directional steering: the player gives the direction to drive in and the car steers toward it.
 * Steering grows with the angle between that direction and the car's heading, reaching full
 * steer at this angle (smaller = more aggressive).
 */
export const CAR_STEER_FULL_ANGLE = (60 * Math.PI) / 180;
/** Beyond this angle off the wanted direction, the handbrake comes on by itself (handbrake turn). */
export const CAR_AUTO_HANDBRAKE_ANGLE = (80 * Math.PI) / 180;
/** Directions shorter than this count as "stick centered" (the car brakes). */
export const CAR_INPUT_DEADZONE = 0.05;
