import { CAR_AUTO_HANDBRAKE_ANGLE, CAR_INPUT_DEADZONE, CAR_STEER_FULL_ANGLE } from "./constants.js";
import { INPUT_BUTTONS } from "../../constants.js";

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

/** What the car does with a `CarInput`, given its heading. Every handling model gets these. */
export interface CarControls {
  /** -1 (left) .. 1 (right). */
  steer: number;
  /** 0 .. 1 forward drive. */
  throttle: number;
  brake: boolean;
  handbrake: boolean;
}

/** The wire input every mini-game shares (the server's `GameInput`), structurally. */
export interface GameInputLike {
  x: number;
  y: number;
  buttons: number;
}

export const clamp = (value: number, min: number, max: number) =>
  (value < min ? min : value > max ? max : value);

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

/** Map the shared wire input to car input: (x, y) = wanted direction, action button = handbrake. */
export const toCarInput = (input: GameInputLike, out: CarInput = { ...NEUTRAL_INPUT }): CarInput => {
  out.dirX = input.x;
  out.dirY = input.y;
  out.handbrake = (input.buttons & INPUT_BUTTONS.ACTION) !== 0;
  return out;
};
