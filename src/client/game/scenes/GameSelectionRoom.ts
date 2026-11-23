import { GameObjects, Scene } from 'phaser'
import type { Room } from '@colyseus/sdk'
import { MAX_PLAYERS_PER_ROOM } from '../../../shared/constants'
import { MINI_GAMES, miniGameIndex } from '../../../shared/games'
import { currentRoom, leaveCurrentRoom } from '../../core/session'
import { createButton, setButtonEnabled, setButtonLabel, textStyle, titleStyle } from '../../core/ui'
import { loadMiniGameScene } from '../../games/registry'

/** The fields of the server's room state this scene reads. */
interface PlayerView {
  name: string
  ready: boolean
}

interface RoomStateView {
  phase: string
  selectedMiniGame: string
  players: Map<string, PlayerView>
}

/** One of the player slots in the grid. */
interface Slot {
  bg: GameObjects.Rectangle
  name: GameObjects.Text
  readyLabel: GameObjects.Text
  readyDot: GameObjects.Arc
}

const BUTTONS_Y = 190
const BUTTON_WIDTH = 300
const BUTTON_HEIGHT = 70
const STATUS_Y = 255

const SELECTION_Y = 400
const SELECTION_WIDTH = 1000
const SELECTION_HEIGHT = 200
const ARROW_OFFSET = 600
const ARROW_SIZE = 70

const SLOT_COLUMNS = 2
const SLOT_WIDTH = 700
const SLOT_HEIGHT = 90
const SLOT_GAP_X = 40
const SLOT_GAP_Y = 20
const SLOTS_TOP = 545

const COLOR_PANEL = 0x3d464a
const COLOR_SLOT_EMPTY = 0x353d40
const COLOR_ARROW = 0x7d8f96
const COLOR_ARROW_HOVER = 0xffffff
const COLOR_OWN_SLOT = 0xe0c068
const COLOR_READY = 0x47ab6f
const COLOR_NOT_READY = 0x5a5f61

/**
 * The room players are in after creating or joining one from the Lobby: pick a mini-game,
 * see who is here, and mark yourself ready.
 */
export class GameSelectionRoom extends Scene {
  room: Room
  leaveButton: GameObjects.Container
  readyButton: GameObjects.Container
  statusText: GameObjects.Text
  gameTitle: GameObjects.Text
  gameDescription: GameObjects.Text
  gameCounter: GameObjects.Text
  slots: Slot[] = []
  /** The connection dropped and the SDK is trying to get it back; messages would be lost. */
  dropped = false
  /** The selected mini-game's scene is being loaded; it starts once it is ready. */
  startingGame = false
  /** Detaches this scene from the room events (the room outlives the scene). */
  removeRoomHandlers: () => void

  constructor() {
    super('GameSelectionRoom')
  }

  /** Our own player in the room state. */
  get me(): PlayerView | undefined {
    return this.state?.players.get(this.room.sessionId)
  }

  get state(): RoomStateView | undefined {
    return this.room.state as RoomStateView | undefined
  }

  create() {
    // Nothing to show without a room (e.g. it closed while switching scenes)
    if (!currentRoom) {
      this.scene.start('Lobby')
      return
    }

    this.room = currentRoom
    this.dropped = false
    this.startingGame = false
    this.slots = []

    const { width } = this.scale
    const centerX = width / 2

    this.add.text(centerX, 90, 'Game Selection', titleStyle).setOrigin(0.5)

    this.leaveButton = this.add.existing(createButton(this, centerX - BUTTON_WIDTH / 2 - 20, BUTTONS_Y,
      BUTTON_WIDTH, BUTTON_HEIGHT, 'Leave', () => this.onLeave()))
    this.readyButton = this.add.existing(createButton(this, centerX + BUTTON_WIDTH / 2 + 20, BUTTONS_Y,
      BUTTON_WIDTH, BUTTON_HEIGHT, 'Ready', () => this.onToggleReady()))
    this.statusText = this.add.text(centerX, STATUS_Y, '', textStyle(26, '#d9776c')).setOrigin(0.5)

    this.createGameSelection(centerX)
    this.createSlots(centerX)

    // Room events; the room outlives this scene, so the handlers are removed again on the way out
    const onStateChange = () => this.render()
    const onDrop = () => this.setDropped(true)
    const onReconnect = () => this.setDropped(false)
    // Kicked, room disposed, or the seat expired while dropped
    const onLeave = () => this.scene.start('Lobby')
    this.room.onStateChange(onStateChange)
    this.room.onDrop(onDrop)
    this.room.onReconnect(onReconnect)
    this.room.onLeave(onLeave)

    this.removeRoomHandlers = () => {
      this.room.onStateChange.remove(onStateChange)
      this.room.onDrop.remove(onDrop)
      this.room.onReconnect.remove(onReconnect)
      this.room.onLeave.remove(onLeave)
    }
    this.events.once('shutdown', this.removeRoomHandlers)
    // Switching games (Ctrl+←/→) destroys the scene without a shutdown
    this.events.once('destroy', () => {
      this.removeRoomHandlers()
      leaveCurrentRoom()
    })

    this.render()
  }

  /** The selected game's card, with arrows on both sides to cycle through `MINI_GAMES`. */
  private createGameSelection(centerX: number) {
    this.add.rectangle(centerX, SELECTION_Y, SELECTION_WIDTH, SELECTION_HEIGHT, COLOR_PANEL)
      .setStrokeStyle(3, 0x000000)
    this.gameTitle = this.add.text(centerX, SELECTION_Y - 40, '', textStyle(48)).setOrigin(0.5)
    this.gameDescription = this.add.text(centerX, SELECTION_Y + 25, '', textStyle(28, '#9fb3bb')).setOrigin(0.5)
    this.gameCounter = this.add.text(centerX, SELECTION_Y + 70, '', textStyle(22, '#9fb3bb')).setOrigin(0.5)

    this.createArrow(centerX - ARROW_OFFSET, -1)
    this.createArrow(centerX + ARROW_OFFSET, 1)
  }

  private createArrow(x: number, direction: -1 | 1) {
    const half = ARROW_SIZE / 2
    // Points right; flipped for the left arrow
    const arrow = this.add.triangle(x, SELECTION_Y, 0, 0, ARROW_SIZE, half, 0, ARROW_SIZE, COLOR_ARROW)
      .setStrokeStyle(3, 0x000000)
      .setScale(direction, 1)
      .setInteractive({ useHandCursor: true })

    arrow.on('pointerover', () => arrow.setFillStyle(COLOR_ARROW_HOVER))
    arrow.on('pointerout', () => arrow.setFillStyle(COLOR_ARROW))
    arrow.on('pointerup', () => this.onCycleGame(direction))
  }

  /** `MAX_PLAYERS_PER_ROOM` slots, filled row by row in join order. */
  private createSlots(centerX: number) {
    const gridWidth = SLOT_COLUMNS * SLOT_WIDTH + (SLOT_COLUMNS - 1) * SLOT_GAP_X
    const left = centerX - gridWidth / 2

    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      const column = i % SLOT_COLUMNS
      const row = Math.floor(i / SLOT_COLUMNS)
      const x = left + column * (SLOT_WIDTH + SLOT_GAP_X)
      const midY = SLOTS_TOP + row * (SLOT_HEIGHT + SLOT_GAP_Y) + SLOT_HEIGHT / 2

      this.slots.push({
        bg: this.add.rectangle(x, midY, SLOT_WIDTH, SLOT_HEIGHT, COLOR_SLOT_EMPTY).setOrigin(0, 0.5),
        name: this.add.text(x + 30, midY, '', textStyle(34)).setOrigin(0, 0.5),
        readyLabel: this.add.text(x + SLOT_WIDTH - 75, midY, '', textStyle(26)).setOrigin(1, 0.5),
        readyDot: this.add.circle(x + SLOT_WIDTH - 45, midY, 16, COLOR_NOT_READY).setStrokeStyle(3, 0x000000),
      })
    }
  }

  /** Bring everything in line with the room state (called on every state patch). */
  private render() {
    const state = this.state
    if (!state) return

    // Everyone is ready: the selected mini-game runs
    if (state.phase === 'playing') {
      this.startMiniGame(state.selectedMiniGame)
      return
    }

    const index = miniGameIndex(state.selectedMiniGame)
    const game = MINI_GAMES[index]
    this.gameTitle.setText(game.title)
    this.gameDescription.setText(game.description)
    this.gameCounter.setText(`${index + 1} / ${MINI_GAMES.length}`)

    const players = [...state.players.entries()]
    this.slots.forEach((slot, i) => {
      const [sessionId, player] = players[i] ?? []
      const isMe = sessionId === this.room.sessionId

      slot.bg.setFillStyle(player ? COLOR_PANEL : COLOR_SLOT_EMPTY)
      slot.bg.setStrokeStyle(3, isMe ? COLOR_OWN_SLOT : 0x000000)
      slot.name.setText(player ? player.name : 'Empty').setColor(player ? '#ffffff' : '#6c777b')
      slot.readyLabel.setVisible(!!player).setText(player?.ready ? 'Ready' : 'Not ready')
        .setColor(player?.ready ? '#7fd39c' : '#9fb3bb')
      slot.readyDot.setVisible(!!player).setFillStyle(player?.ready ? COLOR_READY : COLOR_NOT_READY)
    })

    this.refreshButtons()
  }

  /** Load the mini-game's scene (lazily, the first time) and switch to it. */
  private async startMiniGame(id: string) {
    if (this.startingGame) return
    this.startingGame = true

    let key: string
    try {
      key = await loadMiniGameScene(this.scene, id)
    } catch (e) {
      console.warn('Loading the mini-game failed', e)
      if (!this.sys.isActive()) return
      this.startingGame = false
      this.statusText.setText('Could not load the game')
      return
    }

    // Left the room, or the game ended, while it was loading
    if (!this.sys.isActive() || this.state?.phase !== 'playing') {
      this.startingGame = false
      return
    }
    this.scene.start(key)
  }

  private refreshButtons() {
    setButtonLabel(this.readyButton, this.me?.ready ? 'Not ready' : 'Ready')
    setButtonEnabled(this.readyButton, !this.dropped && !!this.me)
  }

  private setDropped(dropped: boolean) {
    this.dropped = dropped
    this.statusText.setText(dropped ? 'Connection lost, reconnecting…' : '')
    this.refreshButtons()
  }

  private onLeave() {
    // Our own leave must not also trigger the "room closed" handler
    this.removeRoomHandlers()
    leaveCurrentRoom()
    this.scene.start('Lobby')
  }

  private onToggleReady() {
    const me = this.me
    if (!me || this.dropped) return
    this.room.send('setReady', !me.ready)
  }

  private onCycleGame(direction: -1 | 1) {
    const state = this.state
    if (!state || this.dropped) return
    const index = miniGameIndex(state.selectedMiniGame)
    const next = MINI_GAMES[(index + direction + MINI_GAMES.length) % MINI_GAMES.length]
    this.room.send('selectGame', next.id)
  }
}
