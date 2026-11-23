import { schema, t, type SchemaType } from "@colyseus/schema"
import { DEFAULT_MINI_GAME } from "../../../shared/games.js";

/**
 * One input frame, consumed by `Room.defineInput()`. Flat primitives only, and
 * deliberately minimal:
 *   - no `seq`  — the engine's input counter is the sequence
 *   - no `dt`   — fixed timestep: one input advances exactly one step
 *   - no time   — the SDK stamps lag-comp timing on the wire envelope
 *
 * `int8<-1 | 0 | 1>` narrows the type for your code; the room's `sanitize`
 * clamp is what actually enforces it against a modified client.
 */
export const MoveInput = schema({
  moveX: t.int8<-1 | 0 | 1>(),
  moveY: t.int8<-1 | 0 | 1>(),
})
export type MoveInput = SchemaType<typeof MoveInput>

export const Player = schema({
  name: t.string().default("no-name"),
  /** Ready to start the selected mini-game. */
  ready: t.boolean().default(false),
  x: t.number(),
  y: t.number(),
  vx: t.number(),
  vy: t.number(),
})
export type Player = SchemaType<typeof Player>

export const MyRoomState = schema({
  /** Id of the mini-game picked in the selection room (one of `MINI_GAMES`). */
  selectedMiniGame: t.string().default(DEFAULT_MINI_GAME),
  players: t.map(Player),
})
export type MyRoomState = SchemaType<typeof MyRoomState>
