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

/** A few "buildings" to drive around. */
const BUILDINGS: MapBlock[] = [
  // { x: 800, y: 700, width: 400, height: 300 },
];

/** Everything static in the world. Client draws it, both sides build bodies from it. */
export const MAP_BLOCKS: readonly MapBlock[] = [...BUILDINGS];

/**
 * How far up the road (from its start at the origin, where the destruction starts) the front row
 * spawns. A car starting from standstill falls up to ~900 behind the front before it's up to
 * speed, plus the ragged edge (`CHUNK_JITTER`), so this leaves a few hundred units of slack.
 */
const SPAWN_HEAD_START = 1500;

/**
 * One spawn per seat (`MAX_PLAYERS_PER_ROOM`): two rows of four on the road's first piece (always
 * a straight north from the origin, `START_STRAIGHT_LENGTH`), facing north.
 */
export const SPAWN_POINTS: readonly SpawnPoint[] = Array.from({ length: 8 }, (_, i) => ({
  x: ((i % 4) - 1.5) * 100,
  y: -SPAWN_HEAD_START - Math.floor(i / 4) * 100,
  angle: -Math.PI / 2,
}));
