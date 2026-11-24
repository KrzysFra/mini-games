import { sanitizeCarSettings } from "./games/car-roquelike/settings.js";

/**
 * Room settings per mini-game (the gear in the game selection room). The room state keeps each
 * game's settings as JSON (`gameSettings`, by `MINI_GAMES` id; missing = that game's defaults).
 * Games without an entry here have no settings.
 */
const SETTINGS_SANITIZERS: Record<string, (raw: unknown) => object | undefined> = {
  "car-roquelike": sanitizeCarSettings,
};

export const hasGameSettings = (id: string): boolean => id in SETTINGS_SANITIZERS;

/**
 * A game's settings from untrusted input (a client message), as the JSON to store; undefined if
 * the game has no settings or these aren't valid.
 */
export function sanitizeGameSettings(id: string, raw: unknown): string | undefined {
  const settings = SETTINGS_SANITIZERS[id]?.(raw);
  return settings ? JSON.stringify(settings) : undefined;
}
