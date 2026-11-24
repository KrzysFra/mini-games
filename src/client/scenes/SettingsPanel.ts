import { createHtmlButton } from '@core/ui'
import { settingsEditor, type SettingsEditor } from '../games/settings'

const PANEL_WIDTH = 1500
const PANEL_MAX_HEIGHT = 900

/**
 * The room settings of the selected mini-game, as an HTML panel over the game selection room (the
 * gear button opens it): the game's editor (`games/settings.ts`), or "No settings available".
 * It covers the whole screen (clicking outside the panel, ✕ or Escape closes it) and lives in
 * Phaser's DOM container, which is game-sized and CSS-scaled with the canvas.
 */
export class SettingsPanel {
  private overlay: HTMLDivElement
  private title: HTMLDivElement
  private content: HTMLDivElement
  private gameId: string | undefined
  private editor: SettingsEditor | undefined
  private onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose() }

  /**
   * `send(game, settings)` asks the room to change a game's settings (`null` = its defaults).
   */
  constructor(
    container: HTMLElement,
    private send: (game: string, settings: object | null) => void,
    private onClose: () => void,
  ) {
    this.overlay = document.createElement('div')
    Object.assign(this.overlay.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.6)',
      pointerEvents: 'auto', // the DOM container itself ignores pointer events
    })
    this.overlay.addEventListener('pointerdown', e => { if (e.target === this.overlay) this.onClose() })

    const panel = document.createElement('div')
    Object.assign(panel.style, {
      width: `${PANEL_WIDTH}px`, maxHeight: `${PANEL_MAX_HEIGHT}px`, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      padding: '30px 40px', background: '#3d464a', border: '3px solid #000000',
      font: '24px Arial', color: '#ffffff',
    })

    const header = document.createElement('div')
    Object.assign(header.style, { display: 'flex', alignItems: 'center', marginBottom: '20px' })
    this.title = document.createElement('div')
    Object.assign(this.title.style, { flex: '1', font: '44px Arial' })
    const close = createHtmlButton('✕', () => this.onClose())
    close.title = 'Close'
    header.append(this.title, close)

    this.content = document.createElement('div')
    Object.assign(this.content.style, { overflow: 'auto', minHeight: '0' })

    panel.append(header, this.content)
    this.overlay.appendChild(panel)
    container.appendChild(this.overlay)
    document.addEventListener('keydown', this.onKeyDown)
  }

  /** Show `gameId`'s settings (`json`: the room state's, undefined = its defaults). */
  update(gameId: string, title: string, json: string | undefined) {
    if (gameId !== this.gameId) {
      this.gameId = gameId
      this.title.textContent = `Settings: ${title}`
      this.content.replaceChildren()
      this.editor = settingsEditor(gameId)?.(settings => this.send(gameId, settings))
      if (this.editor) {
        this.content.appendChild(this.editor.element)
      } else {
        const none = document.createElement('div')
        none.textContent = 'No settings available'
        Object.assign(none.style, { padding: '40px 0', textAlign: 'center', font: '32px Arial', color: '#9fb3bb' })
        this.content.appendChild(none)
      }
    }
    this.editor?.update(json)
  }

  destroy() {
    document.removeEventListener('keydown', this.onKeyDown)
    this.overlay.remove()
  }
}
