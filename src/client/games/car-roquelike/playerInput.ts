import { Input, type Scene } from 'phaser'
import { INPUT_BUTTONS } from '@shared/constants'
import type { GameInputLike } from '@shared/games/car-roquelike/controls'

/** Stick deflection ignored around the center (= brake); the rest is rescaled to 0..1. */
const STICK_DEADZONE = 0.15
/** Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping). */
export const PAD_START = 9
export const PAD_BACK = 8

type DriveKeys = Record<'up' | 'down' | 'left' | 'right' | 'w' | 'a' | 's' | 'd' | 'space', Input.Keyboard.Key>

export const addDriveKeys = (scene: Scene): DriveKeys => {
  const K = Input.Keyboard.KeyCodes
  return scene.input.keyboard.addKeys({
    up: K.UP, down: K.DOWN, left: K.LEFT, right: K.RIGHT, w: K.W, a: K.A, s: K.S, d: K.D, space: K.SPACE,
  }) as DriveKeys
}

/**
 * Stick position with a round deadzone: the direction is kept, the length rescaled so it starts
 * at 0 just outside the deadzone and reaches 1 at full deflection. Writes into `out`.
 */
const stickWithDeadzone = (x: number, y: number, out: { x: number, y: number }) => {
  const length = Math.hypot(x, y)
  const scaled = length < STICK_DEADZONE ? 0 : Math.min(1, (length - STICK_DEADZONE) / (1 - STICK_DEADZONE))
  out.x = scaled > 0 ? (x / length) * scaled : 0
  out.y = scaled > 0 ? (y / length) * scaled : 0
}

const stick = { x: 0, y: 0 }

/**
 * The direction the player wants to drive in, in screen space (= world space, the camera is
 * north-up): keyboard, D-pad and `pad` (pad1)'s left stick added up, at most length 1. The shared
 * physics steers the car toward it (`resolveCarControls`); length 0 brakes. A / Space = handbrake.
 */
export function readDriveInput(keys: DriveKeys, pad: Input.Gamepad.Gamepad | undefined, out: GameInputLike) {
  let x = (keys.right.isDown || keys.d.isDown ? 1 : 0) - (keys.left.isDown || keys.a.isDown ? 1 : 0)
  let y = (keys.down.isDown || keys.s.isDown ? 1 : 0) - (keys.up.isDown || keys.w.isDown ? 1 : 0)
  let handbrake = keys.space.isDown

  // Browsers only report a pad after one of its buttons is pressed while the page has focus
  if (pad?.connected) {
    // Raw axes (Phaser's leftStick applies a square per-axis threshold); +y is down, like the screen
    stickWithDeadzone(pad.axes[0]?.value ?? 0, pad.axes[1]?.value ?? 0, stick)
    x += stick.x + (pad.right ? 1 : 0) - (pad.left ? 1 : 0)
    y += stick.y + (pad.down ? 1 : 0) - (pad.up ? 1 : 0)
    handbrake ||= pad.A
  }

  // Diagonals (two keys, or stick + key) would be longer than 1
  const length = Math.hypot(x, y)
  out.x = length > 1 ? x / length : x
  out.y = length > 1 ? y / length : y
  out.buttons = handbrake ? INPUT_BUTTONS.ACTION : 0
}
