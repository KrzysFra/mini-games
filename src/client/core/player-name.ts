const STORAGE_KEY = 'mini-games.playerName'

/**
 * The player's last chosen name, or '' if none is stored. localStorage can be unavailable or
 * throw (private mode, blocked site data), so failures fall back to no name.
 */
export const loadPlayerName = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Remember the player's name for the next visit; an empty name clears it. */
export const savePlayerName = (name: string) => {
  try {
    if (name) localStorage.setItem(STORAGE_KEY, name)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable — the name just won't persist
  }
}
