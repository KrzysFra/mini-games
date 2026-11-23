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
})
export type Player = SchemaType<typeof Player>

/** "selection": picking a game in the selection room; "playing": the selected mini-game runs. */
export type RoomPhase = "selection" | "playing"

export const GameSelectionRoomState = schema({
  phase: t.string<RoomPhase>().default("selection"),
  /** Id of the mini-game picked in the selection room (one of `MINI_GAMES`). */
  selectedMiniGame: t.string().default(DEFAULT_MINI_GAME),
  players: t.map(Player),
})
export type GameSelectionRoomState = SchemaType<typeof GameSelectionRoomState>
