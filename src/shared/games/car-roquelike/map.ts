import { ARENA_HEIGHT, ARENA_WIDTH, WALL_THICKNESS } from "./constants.js";

/** An axis-aligned static rectangle, by its center. */
export interface MapBlock {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpawnPoint {
  x: number;
  y: number;
  angle: number;
}

const half = WALL_THICKNESS / 2;

/** Outer walls, just inside the arena bounds. */
const WALLS: MapBlock[] = [
  { x: ARENA_WIDTH / 2, y: half, width: ARENA_WIDTH, height: WALL_THICKNESS },
  { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT - half, width: ARENA_WIDTH, height: WALL_THICKNESS },
  { x: half, y: ARENA_HEIGHT / 2, width: WALL_THICKNESS, height: ARENA_HEIGHT },
  { x: ARENA_WIDTH - half, y: ARENA_HEIGHT / 2, width: WALL_THICKNESS, height: ARENA_HEIGHT },
];

/** A few "buildings" to drive around. */
const BUILDINGS: MapBlock[] = [
  // { x: 800, y: 700, width: 400, height: 300 },
  // { x: 2400, y: 700, width: 400, height: 300 },
  // { x: 800, y: 1700, width: 400, height: 300 },
  // { x: 2400, y: 1700, width: 400, height: 300 },
  // { x: 1600, y: 1200, width: 240, height: 240 },
];

/** Everything static in the world. Client draws it, both sides build bodies from it. */
export const MAP_BLOCKS: readonly MapBlock[] = [...WALLS, ...BUILDINGS];

/** One spawn per seat (`MAX_PLAYERS_PER_ROOM`): a row along the bottom street, facing up. */
export const SPAWN_POINTS: readonly SpawnPoint[] = Array.from({ length: 8 }, (_, i) => ({
  x: 1600 + (i - 3.5) * 140,
  y: 2150,
  angle: -Math.PI / 2,
}));
