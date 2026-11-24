import { createCarSettingsEditor } from './car-roquelike/SettingsEditor'

/**
 * Editors for the mini-games' room settings (the gear in the game selection room), by `MINI_GAMES`
 * id. A game without one shows "No settings available". The server's side of a game's settings
 * (what is valid) is `shared/game-settings.ts`.
 */
export interface SettingsEditor {
  /** The editor's HTML, placed in the settings panel. */
  element: HTMLElement
  /** The room's settings for the game changed (its JSON from the room state; undefined = defaults). */
  update(json: string | undefined): void
}

/** `send(settings)` asks the room to change the game's settings (`null` = back to its defaults). */
export type SettingsEditorFactory = (send: (settings: object | null) => void) => SettingsEditor

const SETTINGS_EDITORS: Record<string, SettingsEditorFactory> = {
  'car-roquelike': createCarSettingsEditor,
}

export const settingsEditor = (id: string): SettingsEditorFactory | undefined => SETTINGS_EDITORS[id]
