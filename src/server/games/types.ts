import type { InputAPI, StepContext } from "colyseus";
import type { GameInput, GameSelectionRoomState } from "../rooms/schema/MiniGameRoomState.js";

/**
 * The server side of a running mini-game that simulates something: created when the room's
 * `phase` becomes `"playing"`, stepped on every fixed tick, disposed when the game ends.
 */
export interface ServerMiniGame {
  addPlayer(sessionId: string): void;
  removePlayer(sessionId: string): void;
  step(ctx: StepContext, inputs: InputAPI<GameInput>): void;
  /** Free the simulation and clear what it put in the room state. */
  dispose(): void;
}

export type ServerMiniGameFactory = (state: GameSelectionRoomState) => ServerMiniGame;
