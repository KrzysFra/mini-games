import {
  DEFAULT_OBSTACLE_WEIGHT_STEPS, KIND_LIST, OBSTACLE_WEIGHTS, obstacleWeightSteps,
  type ObstacleKind, type ObstacleWeights, type ObstacleWeightSteps,
} from "./obstacles.js";

/**
 * car-roquelike's room settings (the gear in the game selection room): stored in the room state
 * as JSON (`gameSettings`, see `shared/game-settings.ts`), always sanitized by the server.
 */
export interface CarRoquelikeSettings {
  /** Replaces `OBSTACLE_WEIGHTS` (same format: `[relative distance, { kind → weight }]` rows). */
  obstacleWeights: ObstacleWeights;
}

export const DEFAULT_CAR_SETTINGS: CarRoquelikeSettings = { obstacleWeights: OBSTACLE_WEIGHTS };

/** Most rows in an obstacle weights table. */
export const MAX_WEIGHT_ROWS = 32;
/** Largest relative distance of a row. */
export const MAX_WEIGHT_DISTANCE = 1_000_000;
/** Largest weight of a kind (a total of 1 / `OBSTACLE_CHANCE` already spawns on every segment). */
export const MAX_WEIGHT = 10;

const clampNumber = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;

/** Settings from untrusted input (a client message), or undefined if they aren't settings at all. */
export function sanitizeCarSettings(raw: unknown): CarRoquelikeSettings | undefined {
  const rows = (raw as { obstacleWeights?: unknown } | null)?.obstacleWeights;
  if (!Array.isArray(rows) || rows.length > MAX_WEIGHT_ROWS) return undefined;
  const obstacleWeights = rows.map(row => {
    const [distance, weights] = Array.isArray(row) ? row : [];
    const clean: Partial<Record<ObstacleKind, number>> = {};
    for (const kind of KIND_LIST) {
      // (Weights to a thousandth: plenty, and keeps the JSON short)
      const weight = Math.round(clampNumber((weights as Record<string, unknown> | null)?.[kind], MAX_WEIGHT) * 1000) / 1000;
      if (weight > 0) clean[kind] = weight;
    }
    return [Math.round(clampNumber(distance, MAX_WEIGHT_DISTANCE)), clean] as const;
  });
  return { obstacleWeights };
}

/** The settings in a room state's JSON (missing or broken: the defaults). */
export function parseCarSettings(json: string | undefined): CarRoquelikeSettings {
  if (!json) return DEFAULT_CAR_SETTINGS;
  try {
    return sanitizeCarSettings(JSON.parse(json)) ?? DEFAULT_CAR_SETTINGS;
  } catch {
    return DEFAULT_CAR_SETTINGS;
  }
}

let cachedJson: string | undefined;
let cachedSteps: ObstacleWeightSteps = DEFAULT_OBSTACLE_WEIGHT_STEPS;

/** The obstacle weight steps for a room state's settings JSON (cached for the last JSON seen). */
export function obstacleWeightStepsFor(json: string | undefined): ObstacleWeightSteps {
  if (json !== cachedJson) {
    cachedJson = json;
    cachedSteps = json ? obstacleWeightSteps(parseCarSettings(json).obstacleWeights) : DEFAULT_OBSTACLE_WEIGHT_STEPS;
  }
  return cachedSteps;
}
