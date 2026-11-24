import type { Scene, Scenes } from 'phaser'

type SceneClass = new () => Scene

/** How the client runs one mini-game: the scene's key, and a lazy import of its class. */
interface ClientMiniGame {
  /** Must match the key the scene passes to `super()`. */
  key: string
  /** Dynamic import, so each game (and its engines/assets) is its own chunk, fetched when first played. */
  load: () => Promise<SceneClass>
}

const placeholder: ClientMiniGame = {
  key: 'PlaceholderGame',
  load: () => import('./placeholder/PlaceholderGame').then(m => m.PlaceholderGame),
}

const carRoquelike: ClientMiniGame = {
  key: 'CarRoquelikeGame',
  load: () => import('./car-roquelike/CarRoquelikeGame').then(m => m.CarRoquelikeGame),
}

const carRoquelikeMjsTorque: ClientMiniGame = {
  key: 'CarRoquelikeMjsTorqueGame',
  load: () => import('./car-roquelike-mjs-torque/CarRoquelikeMjsTorqueGame').then(m => m.CarRoquelikeMjsTorqueGame),
}

const carRoquelikeMjsAxle: ClientMiniGame = {
  key: 'CarRoquelikeMjsAxleGame',
  load: () => import('./car-roquelike-mjs-axle/CarRoquelikeMjsAxleGame').then(m => m.CarRoquelikeMjsAxleGame),
}

/** Client side of each `MINI_GAMES` entry (`src/shared/games.ts`), by id. */
const CLIENT_MINI_GAMES: Record<string, ClientMiniGame> = {
  'car-roquelike': carRoquelike,
  'car-roquelike-mjs-torque': carRoquelikeMjsTorque,
  'car-roquelike-mjs-axle': carRoquelikeMjsAxle,
  'placeholder-1': placeholder,
  'placeholder-2': placeholder,
  'placeholder-3': placeholder,
}

/** The client game for a `MINI_GAMES` id; unknown ids fall back to the placeholder. */
export const clientMiniGame = (id: string): ClientMiniGame => CLIENT_MINI_GAMES[id] ?? placeholder

/**
 * Make sure the mini-game's scene is registered with the game (importing it on first use)
 * and return its key, ready for `scene.start`.
 */
export const loadMiniGameScene = async (scenes: Scenes.ScenePlugin, id: string): Promise<string> => {
  const game = clientMiniGame(id)
  if (!scenes.get(game.key)) {
    const SceneType = await game.load()
    // Checked again: another load may have finished while this one was pending
    if (!scenes.get(game.key)) scenes.add(game.key, SceneType, false)
  }
  return game.key
}
