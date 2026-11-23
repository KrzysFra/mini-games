import { Cameras, GameObjects, Math as PMath, Scene, Types } from 'phaser'
import { loadPlayerName, savePlayerName } from '../../core/player-name'

/** Subset of the Colyseus room listing, so the network can feed it 1:1 later. */
export interface RoomListing {
  roomId: string
  name: string
  clients: number
  maxClients: number
}

const PLACEHOLDER_ROOMS: RoomListing[] = [
  { roomId: 'xK3f9aLq2', name: 'Pill Arena', clients: 3, maxClients: 8 },
  { roomId: 'b7TzQw41p', name: 'Casual Fun', clients: 1, maxClients: 8 },
  { roomId: 'Hn02vRmc8', name: 'Full House', clients: 8, maxClients: 8 },
  { roomId: 'pQ9sLe5Yt', name: 'Practice', clients: 2, maxClients: 4 },
]

const PANEL_WIDTH = 1400
const LIST_TOP = 300
const LIST_BOTTOM_MARGIN = 60
const ROW_HEIGHT = 70
const COL_NAME = 40
const COL_PLAYERS = 760
const COL_ID = 960
const SCROLL_SPEED = 0.6
const SCROLLBAR_WIDTH = 12
const HEADER_Y = 190
const NAME_MIN_LENGTH = 4
const NAME_MAX_LENGTH = 20

/**
 * The list lives far off to the side of the world and is shown only through `listCam`,
 * whose viewport is the list area. That clips rows outside the viewport, both for
 * rendering and for input, without needing masks.
 */
const LIST_WORLD_X = 10000

const COLOR_ROW_A = 0x3d464a
const COLOR_ROW_B = 0x353d40
const COLOR_BUTTON = 0x3a8f5c
const COLOR_BUTTON_HOVER = 0x47ab6f
const COLOR_BUTTON_DISABLED = 0x5a5f61
const COLOR_SCROLL_TRACK = 0x262b2d
const COLOR_SCROLL_THUMB = 0x7d8f96

const textStyle = (size: number, color = '#ffffff'): Types.GameObjects.Text.TextStyle => ({
  fontFamily: 'Arial', fontSize: size, color,
})

export class Lobby extends Scene {
  rooms = new Map<string, RoomListing>()
  list: GameObjects.Container
  listCam: Cameras.Scene2D.Camera
  listHeight: number
  scrollY = 0
  scrollTrack: GameObjects.Rectangle
  scrollThumb: GameObjects.Rectangle
  createRoomButton: GameObjects.Container
  nameInput: HTMLInputElement
  nameBlink: Animation
  playerName = ''
  createdCount = 0

  /** Creating or joining a room needs a name of at least NAME_MIN_LENGTH characters. */
  get nameValid() {
    return this.playerName.length >= NAME_MIN_LENGTH
  }

  constructor() {
    super('Lobby')
  }

  create() {
    const { width, height } = this.scale
    const panelLeft = (width - PANEL_WIDTH) / 2
    this.listHeight = height - LIST_TOP - LIST_BOTTOM_MARGIN
    // Before any button is built, so they start enabled when a valid name is stored
    this.playerName = loadPlayerName().trim().slice(0, NAME_MAX_LENGTH)

    this.add.text(width / 2, 90, 'Lobby', {
      fontFamily: 'Arial Black', fontSize: 72, color: '#ffffff',
      stroke: '#000000', strokeThickness: 8,
    }).setOrigin(0.5)

    this.createRoomButton = this.createButton(panelLeft + PANEL_WIDTH - 140, HEADER_Y, 280, 70, 'Create room',
      () => this.onCreateRoom(), this.nameValid)
    this.add.existing(this.createRoomButton)

    this.createNameInput(panelLeft, HEADER_Y)

    // Column headers
    const headerY = LIST_TOP - 40
    this.add.text(panelLeft + COL_NAME, headerY, 'Name', textStyle(26, '#9fb3bb')).setOrigin(0, 0.5)
    this.add.text(panelLeft + COL_PLAYERS, headerY, 'Players', textStyle(26, '#9fb3bb')).setOrigin(0, 0.5)
    this.add.text(panelLeft + COL_ID, headerY, 'ID', textStyle(26, '#9fb3bb')).setOrigin(0, 0.5)

    // Scrollbar (drawn by the main camera, right of the list)
    const trackX = panelLeft + PANEL_WIDTH + 20
    this.scrollTrack = this.add.rectangle(trackX, LIST_TOP, SCROLLBAR_WIDTH, this.listHeight, COLOR_SCROLL_TRACK)
      .setOrigin(0)
    this.scrollThumb = this.add.rectangle(trackX, LIST_TOP, SCROLLBAR_WIDTH, this.listHeight, COLOR_SCROLL_THUMB)
      .setOrigin(0)
      .setInteractive({ draggable: true, useHandCursor: true })
    this.scrollThumb.on('drag', (_pointer: unknown, _dragX: number, dragY: number) => {
      const travel = this.listHeight - this.scrollThumb.height
      const t = travel > 0 ? (dragY - LIST_TOP) / travel : 0
      this.setScroll(t * this.maxScroll())
    })

    // The list and the camera that shows it
    this.list = this.add.container(LIST_WORLD_X, 0)
    this.cameras.main.ignore(this.list)
    this.listCam = this.cameras.add(panelLeft, LIST_TOP, PANEL_WIDTH, this.listHeight)
    this.listCam.ignore(this.children.list.filter(obj => obj !== this.list))

    this.input.on('wheel', (_pointer: unknown, _objects: unknown, _dx: number, dy: number) => {
      this.setScroll(this.scrollY + dy * SCROLL_SPEED)
    })

    this.setRooms(PLACEHOLDER_ROOMS)
  }

  /** Replace the whole list (future `"rooms"` message). */
  setRooms(rooms: RoomListing[]) {
    this.rooms.clear()
    for (const room of rooms) this.rooms.set(room.roomId, room)
    this.renderList()
  }

  /** Add or update one room (future `"+"` message). */
  addRoom(room: RoomListing) {
    this.rooms.set(room.roomId, room)
    this.renderList()
  }

  /** Remove one room (future `"-"` message). */
  removeRoom(roomId: string) {
    this.rooms.delete(roomId)
    this.renderList()
  }

  /**
   * A real HTML <input> (Phaser has no text input of its own), placed directly in Phaser's DOM
   * container, which is game-sized and CSS-scaled along with the canvas, so game coordinates work.
   * Not a Phaser DOMElement on purpose: those are re-rendered per camera, and `listCam` ignoring
   * it would set `display: none` on it.
   */
  private createNameInput(x: number, centerY: number) {
    const height = 70
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = NAME_MAX_LENGTH
    input.placeholder = 'Enter a name'
    input.spellcheck = false
    input.autocomplete = 'off'
    input.value = this.playerName
    Object.assign(input.style, {
      position: 'absolute',
      left: `${x}px`,
      top: `${centerY - height / 2}px`,
      pointerEvents: 'auto', // the DOM container itself ignores pointer events
      width: '420px',
      height: `${height}px`,
      boxSizing: 'border-box',
      padding: '0 20px',
      font: '30px Arial',
      color: '#ffffff',
      background: '#262b2d',
      border: '3px solid #000000',
      outline: 'none',
    })

    input.addEventListener('input', () => {
      // maxLength stops typing past the limit; slice is a safety net for pasted text
      if (input.value.length > NAME_MAX_LENGTH) input.value = input.value.slice(0, NAME_MAX_LENGTH)
      const wasValid = this.nameValid
      this.playerName = input.value.trim()
      savePlayerName(this.playerName)
      if (this.nameValid !== wasValid) this.onNameValidChanged()
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
    })

    this.game.domContainer.appendChild(input)
    this.events.once('shutdown', () => input.remove())
    this.nameInput = input
    this.updateNameBlink()

    // Phaser prevents default on canvas pointerdown, which would keep the input focused
    this.input.on('pointerdown', () => input.blur())
  }

  /** Gently pulse the name input's border black ↔ red while the name is invalid. */
  private updateNameBlink() {
    if (this.nameValid) {
      this.nameBlink?.cancel()
      this.nameBlink = undefined
      return
    }

    if (this.nameBlink) return
    this.nameBlink = this.nameInput.animate(
      [{ borderColor: '#000000' }, { borderColor: '#d9776c' }],
      { duration: 900, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' },
    )
  }

  private onNameValidChanged() {
    this.updateNameBlink()
    this.setButtonEnabled(this.createRoomButton, this.nameValid)
    // Rows are rebuilt with the new Join state
    this.renderList()
  }

  private onCreateRoom() {
    this.createdCount++
    const roomId = Math.random().toString(36).slice(2, 11)
    this.addRoom({ roomId, name: `Room #${this.createdCount}`, clients: 1, maxClients: 8 })
  }

  private onJoinRoom(room: RoomListing) {
    console.log('join', room.roomId)
  }

  private maxScroll() {
    return Math.max(0, this.rooms.size * ROW_HEIGHT - this.listHeight)
  }

  private setScroll(y: number) {
    this.scrollY = PMath.Clamp(y, 0, this.maxScroll())
    this.listCam.setScroll(LIST_WORLD_X, this.scrollY)
    this.updateScrollbar()
  }

  private updateScrollbar() {
    const content = this.rooms.size * ROW_HEIGHT
    const scrollable = content > this.listHeight
    this.scrollTrack.setVisible(scrollable)
    this.scrollThumb.setVisible(scrollable)
    if (!scrollable) return

    const thumbHeight = Math.max(40, this.listHeight * this.listHeight / content)
    const t = this.scrollY / this.maxScroll()
    this.scrollThumb.setSize(SCROLLBAR_WIDTH, thumbHeight)
    this.scrollThumb.input.hitArea.setSize(SCROLLBAR_WIDTH, thumbHeight)
    this.scrollThumb.y = LIST_TOP + t * (this.listHeight - thumbHeight)
  }

  private renderList() {
    this.list.removeAll(true)

    if (this.rooms.size === 0) {
      this.list.add(
        this.add.text(PANEL_WIDTH / 2, ROW_HEIGHT, 'No active rooms', textStyle(32, '#9fb3bb')).setOrigin(0.5),
      )
    }

    let i = 0
    for (const room of this.rooms.values()) {
      this.list.add(this.createRow(room, i * ROW_HEIGHT, i % 2 === 0 ? COLOR_ROW_A : COLOR_ROW_B))
      i++
    }

    // Re-clamp: the list may have shrunk
    this.setScroll(this.scrollY)
  }

  private createRow(room: RoomListing, y: number, color: number) {
    const full = room.clients >= room.maxClients
    const midY = ROW_HEIGHT / 2

    const bg = this.add.rectangle(0, 0, PANEL_WIDTH, ROW_HEIGHT - 4, color).setOrigin(0)
    const name = this.add.text(COL_NAME, midY, room.name, textStyle(32)).setOrigin(0, 0.5)
    const players = this.add.text(COL_PLAYERS, midY, `${room.clients} / ${room.maxClients}`,
      textStyle(32, full ? '#d9776c' : '#ffffff')).setOrigin(0, 0.5)
    const id = this.add.text(COL_ID, midY, room.roomId, textStyle(26, '#9fb3bb')).setOrigin(0, 0.5)
    const join = this.createButton(PANEL_WIDTH - 100, midY - 2, 160, 50, full ? 'Full' : 'Join',
      () => this.onJoinRoom(room), !full && this.nameValid)

    return this.add.container(0, y, [bg, name, players, id, join])
  }

  /**
   * A button container; not added to the display list, so it can go into a scene or a container.
   * Toggle it later with `setButtonEnabled`.
   */
  private createButton(x: number, y: number, w: number, h: number, label: string, onClick: () => void,
    enabled = true) {
    const bg = new GameObjects.Rectangle(this, 0, 0, w, h, COLOR_BUTTON).setStrokeStyle(3, 0x000000)
    const text = new GameObjects.Text(this, 0, 0, label, textStyle(Math.round(h * 0.45))).setOrigin(0.5)
    const button = new GameObjects.Container(this, x, y, [bg, text])
    const isEnabled = () => button.getData('enabled') === true

    bg.setInteractive()
    bg.on('pointerover', () => { if (isEnabled()) bg.setFillStyle(COLOR_BUTTON_HOVER) })
    bg.on('pointerout', () => { if (isEnabled()) bg.setFillStyle(COLOR_BUTTON); button.setScale(1) })
    bg.on('pointerdown', () => { if (isEnabled()) button.setScale(0.95) })
    bg.on('pointerup', () => {
      button.setScale(1)
      if (isEnabled()) onClick()
    })

    this.setButtonEnabled(button, enabled)
    return button
  }

  private setButtonEnabled(button: GameObjects.Container, enabled: boolean) {
    const [bg, text] = button.list as [GameObjects.Rectangle, GameObjects.Text]
    button.setData('enabled', enabled).setScale(1)
    bg.setFillStyle(enabled ? COLOR_BUTTON : COLOR_BUTTON_DISABLED)
    bg.input.cursor = enabled ? 'pointer' : 'default'
    text.setAlpha(enabled ? 1 : 0.6)
  }
}

export const configLobby = {
  scene: [Lobby],
  dom: { createContainer: true },
}
