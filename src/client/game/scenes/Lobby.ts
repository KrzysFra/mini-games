import { Cameras, GameObjects, Math as PMath, Scene, Time } from 'phaser'
import type { Room } from '@colyseus/sdk'
import { NAME_MAX_LENGTH } from '../../../shared/constants'
import { isValidPlayerName, sanitizePlayerName } from '../../../shared/player-name'
import { client } from '../../core/network'
import { loadPlayerName, savePlayerName } from '../../core/player-name'
import { hasResumableSession, leaveCurrentRoom, resumeSession, setCurrentRoom } from '../../core/session'
import { SANDBOX_GAME, SANDBOX_ROOM } from '../../core/sandbox'
import { createButton, setButtonEnabled, textStyle, titleStyle } from '../../core/ui'
import { loadMiniGameScene } from '../../games/registry'
import { GameSelectionRoom } from './GameSelectionRoom'

/** What the Lobby shows per room. */
export interface RoomListing {
  roomId: string
  name: string
  clients: number
  maxClients: number
  /** Locked rooms reject joins; shown like full ones. */
  locked: boolean
}

/** The fields we use from a room listing sent by the server's LobbyRoom (`IRoomCache`). */
interface ListedRoom {
  roomId: string
  name: string
  clients: number
  maxClients: number
  locked?: boolean
  metadata?: { title?: string }
}

const toListing = (room: ListedRoom): RoomListing => ({
  roomId: room.roomId,
  name: room.metadata?.title ?? room.name,
  clients: room.clients,
  maxClients: room.maxClients,
  locked: room.locked === true,
})

/** Room type the Create button makes (and the lobby lists). */
const GAME_ROOM = 'my_room'
const NAME_SYNC_DELAY = 300

type ConnectionStatus = 'resuming' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

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

/**
 * The list lives far off to the side of the world and is shown only through `listCam`,
 * whose viewport is the list area. That clips rows outside the viewport, both for
 * rendering and for input, without needing masks.
 */
const LIST_WORLD_X = 10000

const COLOR_ROW_A = 0x3d464a
const COLOR_ROW_B = 0x353d40
const COLOR_SCROLL_TRACK = 0x262b2d
const COLOR_SCROLL_THUMB = 0x7d8f96

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
  errorText: GameObjects.Text

  /** Connection to the server's `lobby` room: the room list, and our name on the server. */
  lobbyRoom: Room | undefined
  status: ConnectionStatus = 'connecting'
  /** A create/join request is in flight. */
  busy = false
  /** Set once the scene is going away; late connection results are dropped. */
  disposed = false
  nameSyncTimer: Time.TimerEvent

  /** Creating or joining a room needs a name of at least NAME_MIN_LENGTH characters. */
  get nameValid() {
    return isValidPlayerName(this.playerName)
  }

  /** Create and Join are usable. */
  get canEnterRoom() {
    return this.status === 'connected' && this.nameValid && !this.busy
  }

  constructor() {
    super('Lobby')
  }

  create() {
    const { width, height } = this.scale
    const panelLeft = (width - PANEL_WIDTH) / 2
    this.listHeight = height - LIST_TOP - LIST_BOTTOM_MARGIN
    // Scene instances are reused by scene.start, so reset per-run state
    this.rooms.clear()
    this.scrollY = 0
    this.status = 'connecting'
    this.busy = false
    this.disposed = false
    this.lobbyRoom = undefined
    this.nameBlink = undefined
    this.playerName = sanitizePlayerName(loadPlayerName())

    this.add.text(width / 2, 90, 'Lobby', titleStyle).setOrigin(0.5)

    this.createRoomButton = createButton(this, panelLeft + PANEL_WIDTH - 140, HEADER_Y, 280, 70, 'Create room',
      () => this.onCreateRoom(), this.canEnterRoom)
    this.add.existing(this.createRoomButton)

    this.errorText = this.add.text(width / 2, height - LIST_BOTTOM_MARGIN / 2, '', textStyle(26, '#d9776c'))
      .setOrigin(0.5)

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

    this.renderList()

    // Switching games (Ctrl+←/→) destroys the game, which doesn't emit `shutdown`
    this.events.once('shutdown', () => this.dispose())
    this.events.once('destroy', () => this.dispose())

    this.start()
  }

  /** Resume the game room from before a page reload if possible, otherwise join the lobby. */
  private async start() {
    if (hasResumableSession()) {
      this.setStatus('resuming')
      const room = await resumeSession()
      if (room) {
        if (this.disposed) leaveCurrentRoom()
        else this.scene.start('GameSelectionRoom')
        return
      }
      if (this.disposed) return
    }

    this.connect()
  }

  /** Join the server's lobby room; the room list arrives as its messages. In sandbox mode, join the sandbox instead. */
  private async connect() {
    if (SANDBOX_GAME) {
      this.joinSandbox(SANDBOX_GAME)
      return
    }

    this.setStatus('connecting')

    let room: Room
    try {
      room = await client.joinOrCreate('lobby', { name: this.playerName })
    } catch (e) {
      console.warn('Lobby connection failed', e)
      if (!this.disposed) this.setStatus('failed')
      return
    }

    if (this.disposed) {
      room.leave().catch(() => {})
      return
    }

    this.lobbyRoom = room
    room.onMessage('rooms', (rooms: ListedRoom[]) => this.setRooms(rooms.map(toListing)))
    room.onMessage('+', ([, listed]: [string, ListedRoom]) => this.addRoom(toListing(listed)))
    room.onMessage('-', (roomId: string) => this.removeRoom(roomId))
    room.onDrop(() => { if (this.lobbyRoom === room) this.setStatus('reconnecting') })
    room.onReconnect(() => { if (this.lobbyRoom === room) this.setStatus('connected') })
    room.onLeave(() => {
      // Only an unexpected leave: leaving on purpose clears `lobbyRoom` first
      if (this.lobbyRoom !== room) return
      this.lobbyRoom = undefined
      if (!this.disposed) this.setStatus('failed')
    })

    this.setStatus('connected')
  }

  /** Sandbox mode: join the shared sandbox room and go straight into its mini-game. */
  private async joinSandbox(game: string) {
    this.setStatus('connecting')
    this.errorText.setText('')

    let room: Room
    let key: string
    try {
      room = await client.joinOrCreate(SANDBOX_ROOM, { game, name: this.playerName })
      if (this.disposed) {
        room.leave().catch(() => {})
        return
      }
      setCurrentRoom(room)
      key = await loadMiniGameScene(this.scene, game)
    } catch (e) {
      console.warn('Joining the sandbox failed', e)
      if (room) leaveCurrentRoom()
      if (this.disposed) return
      this.setStatus('failed')
      this.errorText.setText(`Could not join the sandbox: ${e instanceof Error ? e.message : e}`)
      return
    }

    if (this.disposed) leaveCurrentRoom()
    else this.scene.start(key)
  }

  /** Leave the lobby room on purpose (entering a game room, or the scene going away). */
  private leaveLobby() {
    const room = this.lobbyRoom
    this.lobbyRoom = undefined
    room?.leave().catch(() => {})
  }

  private dispose() {
    if (this.disposed) return
    this.disposed = true
    this.nameSyncTimer?.remove()
    this.leaveLobby()
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status
    if (status !== 'connected') this.rooms.clear()
    this.refreshButtons()
  }

  /** Replace the whole list (`"rooms"` message). */
  setRooms(rooms: RoomListing[]) {
    this.rooms.clear()
    for (const room of rooms) this.rooms.set(room.roomId, room)
    this.renderList()
  }

  /** Add or update one room (`"+"` message). */
  addRoom(room: RoomListing) {
    this.rooms.set(room.roomId, room)
    this.renderList()
  }

  /** Remove one room (`"-"` message). */
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
      this.playerName = sanitizePlayerName(input.value)
      savePlayerName(this.playerName)
      if (this.nameValid !== wasValid) this.onNameValidChanged()
      this.scheduleNameSync()
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
    })

    this.game.domContainer.appendChild(input)
    this.events.once('shutdown', () => input.remove())
    this.events.once('destroy', () => input.remove())
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
    this.refreshButtons()
  }

  /** Re-apply the Create / Join enabled state (name, connection or busy state changed). */
  private refreshButtons() {
    setButtonEnabled(this.createRoomButton, this.canEnterRoom)
    // Rows are rebuilt with the new Join state
    this.renderList()
  }

  /** Tell the server our new name once typing pauses. Invalid names are kept local. */
  private scheduleNameSync() {
    this.nameSyncTimer?.remove()
    this.nameSyncTimer = this.time.delayedCall(NAME_SYNC_DELAY, () => {
      if (this.nameValid && this.status === 'connected') this.lobbyRoom?.send('setName', this.playerName)
    })
  }

  private onCreateRoom() {
    this.enterRoom(() => client.create(GAME_ROOM, { name: this.playerName }))
  }

  private onJoinRoom(room: RoomListing) {
    this.enterRoom(() => client.joinById(room.roomId, { name: this.playerName }))
  }

  /** Create or join a game room, then leave the lobby and switch to the room's scene. */
  private async enterRoom(request: () => Promise<Room>) {
    if (!this.canEnterRoom) return
    this.busy = true
    this.errorText.setText('')
    this.refreshButtons()

    let room: Room
    try {
      room = await request()
    } catch (e) {
      console.warn('Entering room failed', e)
      if (this.disposed) return
      this.busy = false
      this.errorText.setText(`Could not enter the room: ${e instanceof Error ? e.message : e}`)
      this.refreshButtons()
      return
    }

    if (this.disposed) {
      room.leave().catch(() => {})
      return
    }

    setCurrentRoom(room)
    this.leaveLobby()
    this.scene.start('GameSelectionRoom')
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
      const message = SANDBOX_GAME
        ? {
          resuming: `Sandbox (${SANDBOX_GAME}): rejoining…`,
          connecting: `Sandbox (${SANDBOX_GAME}): joining…`,
          reconnecting: `Sandbox (${SANDBOX_GAME}): reconnecting…`,
          failed: `Sandbox (${SANDBOX_GAME}): could not join`,
          connected: `Sandbox (${SANDBOX_GAME})`,
        }[this.status]
        : {
          resuming: 'Rejoining your room…',
          connecting: 'Connecting…',
          reconnecting: 'Connection lost, reconnecting…',
          failed: 'Cannot reach the server',
          connected: 'No active rooms',
        }[this.status]
      this.list.add(
        this.add.text(PANEL_WIDTH / 2, ROW_HEIGHT, message, textStyle(32, '#9fb3bb')).setOrigin(0.5),
      )

      if (this.status === 'failed') {
        this.list.add(createButton(this, PANEL_WIDTH / 2, ROW_HEIGHT * 2.2, 200, 60, 'Retry', () => this.connect()))
      }
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
    const full = room.locked || room.clients >= room.maxClients
    const midY = ROW_HEIGHT / 2

    const bg = this.add.rectangle(0, 0, PANEL_WIDTH, ROW_HEIGHT - 4, color).setOrigin(0)
    const name = this.add.text(COL_NAME, midY, room.name, textStyle(32)).setOrigin(0, 0.5)
    const players = this.add.text(COL_PLAYERS, midY, `${room.clients} / ${room.maxClients}`,
      textStyle(32, full ? '#d9776c' : '#ffffff')).setOrigin(0, 0.5)
    const id = this.add.text(COL_ID, midY, room.roomId, textStyle(26, '#9fb3bb')).setOrigin(0, 0.5)
    const join = createButton(this, PANEL_WIDTH - 100, midY - 2, 160, 50, full ? 'Full' : 'Join',
      () => this.onJoinRoom(room), !full && this.canEnterRoom)

    return this.add.container(0, y, [bg, name, players, id, join])
  }
}

export const configLobby = {
  // Mini-game scenes are added at runtime by `src/client/games/registry.ts`
  scene: [Lobby, GameSelectionRoom],
  dom: { createContainer: true },
}
