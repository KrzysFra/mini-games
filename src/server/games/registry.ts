import { CarRoquelikeSim } from "./car-roquelike/CarRoquelikeSim.js";
import { CarRoquelikeMjsTorqueSim } from "./car-roquelike-mjs-torque/CarRoquelikeMjsTorqueSim.js";
import { CarRoquelikeMjsAxleSim } from "./car-roquelike-mjs-axle/CarRoquelikeMjsAxleSim.js";
import type { ServerMiniGameFactory } from "./types.js";

/**
 * Server side of the `MINI_GAMES` entries (`src/shared/games.ts`) that simulate something, by id.
 * Games without an entry (the placeholders) run on room messages alone.
 */
const SERVER_MINI_GAMES: Record<string, ServerMiniGameFactory> = {
  "car-roquelike": state => new CarRoquelikeSim(state),
  "car-roquelike-mjs-torque": state => new CarRoquelikeMjsTorqueSim(state),
  "car-roquelike-mjs-axle": state => new CarRoquelikeMjsAxleSim(state),
};

export const serverMiniGame = (id: string): ServerMiniGameFactory | undefined => SERVER_MINI_GAMES[id];
