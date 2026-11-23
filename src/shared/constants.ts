/** Simulation rate in Hz. One input advances exactly one step at this rate. */
export const TICK_RATE = 30;

export const ARENA_WIDTH = 800;
export const ARENA_HEIGHT = 600;

/** Half-extent of a player square, used for wall clamping. */
export const PLAYER_HALF = 12;

/** Units per second at full stick. */
export const PLAYER_SPEED = 260;

/** Player names: shorter names can't create or join rooms; longer ones are cut. */
export const NAME_MIN_LENGTH = 4;
export const NAME_MAX_LENGTH = 20;

/** Seats in a game room; the selection screen shows one player slot per seat. */
export const MAX_PLAYERS_PER_ROOM = 8;

/** Color of a player's dot in the placeholder game until they press a key. */
export const DEFAULT_DOT_COLOR = 0xff0000;
