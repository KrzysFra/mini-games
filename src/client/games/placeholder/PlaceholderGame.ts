import { GameObjects } from 'phaser'
import { DEFAULT_DOT_COLOR, MAX_PLAYERS_PER_ROOM } from '../../../shared/constants'
import { textStyle, titleStyle } from '../../core/ui'
import { MiniGameParent } from '../MiniGameScene'

/** The fields of the server's room state this scene reads. */
interface PlayerView {
  name: string
  color: number
  escaped: boolean
}

interface RoomStateView {
  phase: string
  players: Map<string, PlayerView>
}

/** One player's dot with their name below it. */
interface Slot {
  dot: GameObjects.Arc
  name: GameObjects.Text
  /** "ESC" inside the dot once the player has escaped. */
  escLabel: GameObjects.Text
}

const DOT_RADIUS = 60
const SLOT_COLUMNS = 4
const SLOT_SPACING_X = 360
const SLOT_SPACING_Y = 300
const SLOTS_CENTER_Y = 580

const COLOR_OWN_SLOT = 0xe0c068

/**
 * Placeholder mini-game (no physics): one dot per player, red at first. Pressing any key gives
 * your dot a random color (picked by the server), and everyone sees it. Escape marks
 * you as done ("ESC" in your dot); once everyone has, the room returns to game selection.
 */
export class PlaceholderGame extends MiniGameParent<RoomStateView> {
  slots: Slot[] = []
  statusText: GameObjects.Text

  constructor() {
    super('PlaceholderGame')
  }

  protected createGame() {
    this.slots = []

    const centerX = this.scale.width / 2
    this.add.text(centerX, 90, 'Placeholder Game', titleStyle).setOrigin(0.5)
    this.add.text(centerX, 180, 'Press any key to change your color, Escape to stop', textStyle(32, '#9fb3bb'))
      .setOrigin(0.5)
    this.statusText = this.add.text(centerX, 240, '', textStyle(26, '#d9776c')).setOrigin(0.5)

    this.createSlots(centerX)

    this.input.keyboard.on('keydown', (e: KeyboardEvent) => {
      if (e.repeat || this.dropped) return
      this.room.send(e.code === 'Escape' ? 'escape' : 'changeColor')
    })
  }

  /** `MAX_PLAYERS_PER_ROOM` dots in a centered grid, filled row by row in join order. */
  private createSlots(centerX: number) {
    const rows = Math.ceil(MAX_PLAYERS_PER_ROOM / SLOT_COLUMNS)

    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      const column = i % SLOT_COLUMNS
      const row = Math.floor(i / SLOT_COLUMNS)
      const x = centerX + (column - (SLOT_COLUMNS - 1) / 2) * SLOT_SPACING_X
      const y = SLOTS_CENTER_Y + (row - (rows - 1) / 2) * SLOT_SPACING_Y

      this.slots.push({
        dot: this.add.circle(x, y, DOT_RADIUS, DEFAULT_DOT_COLOR).setStrokeStyle(4, 0x000000).setVisible(false),
        name: this.add.text(x, y + DOT_RADIUS + 30, '', textStyle(30)).setOrigin(0.5).setVisible(false),
        // Stroked, so it stays readable on any random dot color
        escLabel: this.add.text(x, y, 'ESC', { ...textStyle(40), fontStyle: 'bold', stroke: '#000000', strokeThickness: 6 })
          .setOrigin(0.5).setVisible(false),
      })
    }
  }

  protected renderState(state: RoomStateView) {
    const players = [...state.players.entries()]
    this.slots.forEach((slot, i) => {
      const [sessionId, player] = players[i] ?? []
      const isMe = sessionId === this.room.sessionId

      slot.dot.setVisible(!!player)
      slot.name.setVisible(!!player)
      slot.escLabel.setVisible(!!player?.escaped)
      if (!player) return

      slot.dot.setFillStyle(player.color).setStrokeStyle(isMe ? 6 : 4, isMe ? COLOR_OWN_SLOT : 0x000000)
      slot.name.setText(player.name).setColor(isMe ? '#e0c068' : '#ffffff')
    })
  }

  protected onDroppedChanged(dropped: boolean) {
    this.statusText.setText(dropped ? 'Connection lost, reconnecting…' : '')
  }
}
