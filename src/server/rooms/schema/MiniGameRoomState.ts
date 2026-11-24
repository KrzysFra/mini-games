import { schema, t, type SchemaType } from "@colyseus/schema"
import { DEFAULT_MINI_GAME } from "../../../shared/games.js";
import { DEFAULT_DOT_COLOR } from "../../../shared/constants.js";

export const Player = schema({
  name: t.string().default("no-name"),
  /** Ready to start the selected mini-game. */
  ready: t.boolean().default(false),
  /** The player's dot color (0xRRGGBB) in the placeholder game. */
  color: t.uint32().default(DEFAULT_DOT_COLOR),
  /** Pressed Escape in the placeholder game; when everyone has, the room returns to game selection. */
  escaped: t.boolean().default(false),
  /**
   * Sandbox only: a CPU driver, i.e. an extra connection from a player's tab that sends inputs like
   * any player. Never counts toward "everyone escaped".
   */
  cpu: t.boolean().default(false),
})
export type Player = SchemaType<typeof Player>

/** A car in car-roquelike: its full physics state, so clients can adopt it for prediction. */
export const Car = schema({
  x: t.float32(),
  y: t.float32(),
  angle: t.float32(),
  vx: t.float32(),
  vy: t.float32(),
  /** Angular velocity. */
  av: t.float32(),
  /** Loss of grip after a hit, 0..1 (part of the physics state clients adopt). */
  slip: t.float32(),
  /**
   * The input the server last applied to this car (zeros when none). Clients predict other
   * players' cars with it until the next update.
   */
  inX: t.float32(),
  inY: t.float32(),
  inButtons: t.uint8(),
  /** Seat index: picks the spawn point and the car's color. */
  seat: t.uint8(),
  /** Caught by the destruction front: out of this round (no longer simulated). */
  eliminated: t.boolean().default(false),
})
export type Car = SchemaType<typeof Car>

/**
 * One player input per fixed tick (`defineInput`), shared by every mini-game that needs
 * continuous input: two analog axes plus a button bitmask.
 */
export const GameInput = schema({
  /** car-roquelike: (x, y) = the direction to drive in (+y down), its length the throttle; 0 = brake. */
  x: t.float32(),
  y: t.float32(),
  /** Bit flags, see `INPUT_BUTTONS` in `shared/constants.ts`. */
  buttons: t.uint8(),
})
export type GameInput = SchemaType<typeof GameInput>

/** "selection": picking a game in the selection room; "playing": the selected mini-game runs. */
export type RoomPhase = "selection" | "playing"

export const GameSelectionRoomState = schema({
  phase: t.string<RoomPhase>().default("selection"),
  /** Id of the mini-game picked in the selection room (one of `MINI_GAMES`). */
  selectedMiniGame: t.string().default(DEFAULT_MINI_GAME),
  players: t.map(Player),
  /** car-roquelike: one car per player (by sessionId) while the game runs. */
  cars: t.map(Car),
  /** car-roquelike: rounds played since the game started; goes up on every restart. */
  carRound: t.uint16().default(0),
  /** car-roquelike: ticks this round has run (countdown included); drives the destruction front. */
  carRoundTick: t.uint32().default(0),
  /** car-roquelike: seed of this round's road (`getRoad`); everyone builds the same road from it. */
  roadSeed: t.uint32().default(0),
})
export type GameSelectionRoomState = SchemaType<typeof GameSelectionRoomState>
