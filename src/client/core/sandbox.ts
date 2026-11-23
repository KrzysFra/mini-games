import { DEFAULT_MINI_GAME } from '../../shared/games'

/**
 * Sandbox mode (dev only): set `VITE_SANDBOX=<mini-game id>` in `.env.local` and every client
 * skips the lobby and joins one shared room that runs that mini-game. `true` / `1` picks the
 * default game. Unset or empty: off. Unknown ids are rejected by the server.
 */
const parseSandboxGame = (value: string | undefined): string | undefined => {
  const game = value?.trim()
  if (!game) return undefined
  if (game === 'true' || game === '1') return DEFAULT_MINI_GAME
  return game
}

/** The mini-game every client starts in, or `undefined` when sandbox mode is off. */
export const SANDBOX_GAME = import.meta.env.DEV ? parseSandboxGame(import.meta.env.VITE_SANDBOX) : undefined

/** Room type of the sandbox room (registered by the server outside production). */
export const SANDBOX_ROOM = 'sandbox'
