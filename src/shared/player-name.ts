import { NAME_MAX_LENGTH, NAME_MIN_LENGTH } from "./constants.js";

/** Normalize a player name from any source (input field, storage, the wire): trimmed and length-capped. */
export const sanitizePlayerName = (raw: unknown): string =>
  typeof raw === "string" ? raw.trim().slice(0, NAME_MAX_LENGTH) : "";

/** A (sanitized) name long enough to create or join a room. */
export const isValidPlayerName = (name: string): boolean => name.length >= NAME_MIN_LENGTH;
