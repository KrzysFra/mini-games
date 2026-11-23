/** A mini-game players can pick in the game selection room. */
export interface MiniGameInfo {
  id: string;
  title: string;
  description: string;
}

/** The selectable mini-games, in the order the selection arrows cycle through them. */
export const MINI_GAMES: readonly MiniGameInfo[] = [
  { id: "placeholder-1", title: "Placeholder Game 1", description: "A mini-game yet to be made." },
  { id: "placeholder-2", title: "Placeholder Game 2", description: "Another mini-game yet to be made." },
  { id: "placeholder-3", title: "Placeholder Game 3", description: "Yet another mini-game to be made." },
];

export const DEFAULT_MINI_GAME = MINI_GAMES[0].id;

export const isMiniGameId = (id: unknown): id is string =>
  typeof id === "string" && MINI_GAMES.some(game => game.id === id);

/** Index of a game in `MINI_GAMES`, or 0 for an unknown id. */
export const miniGameIndex = (id: string): number =>
  Math.max(0, MINI_GAMES.findIndex(game => game.id === id));
