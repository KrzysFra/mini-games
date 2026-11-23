import { Scene, Types } from 'phaser'
import type { Room } from '@colyseus/sdk'
import { currentRoom, leaveCurrentRoom } from '../core/session'

/** The room state fields every mini-game relies on. */
export interface MiniGameStateView {
  phase: string
}

/**
 * Base for mini-game scenes: owns the connection to the current room while the game runs.
 * Goes back to `GameSelectionRoom` once the room's `phase` leaves `"playing"`, and to `Lobby`
 * if the room is gone.
 *
 * Physics is per scene: pass it in the scene config, e.g.
 * `super({ key: 'MyGame', physics: { default: 'matter', matter: {} } })`. Leave it out for no physics.
 * An external engine is created in `createGame`, stepped in `update`, and freed in `disposeGame`.
 */
export abstract class MiniGameScene<TState extends MiniGameStateView = MiniGameStateView> extends Scene {
  room: Room
  /** The connection dropped and the SDK is trying to get it back; messages would be lost. */
  dropped = false
  /** Detaches this scene from the room events (the room outlives the scene). */
  private removeRoomHandlers: () => void = () => {}

  constructor(config: string | Types.Scenes.SettingsConfig) {
    super(config)
  }

  get state(): TState | undefined {
    return this.room?.state as TState | undefined
  }

  /** Build the game's objects. `this.room` is set. */
  protected abstract createGame(): void

  /** Bring the game in line with the room state (called on every state patch while `"playing"`). */
  protected abstract renderState(state: TState): void

  /** The connection dropped (`true`) or came back (`false`). */
  protected onDroppedChanged(_dropped: boolean): void {}

  /** Free whatever the game made outside Phaser (external engines, DOM elements). Runs once. */
  protected disposeGame(): void {}

  create() {
    // Nothing to show without a room (e.g. it closed while switching scenes)
    if (!currentRoom) {
      this.scene.start('Lobby')
      return
    }

    this.room = currentRoom
    this.dropped = false

    // Room events; the room outlives this scene, so the handlers are removed again on the way out
    const onStateChange = () => this.onRoomState()
    const onDrop = () => this.setDropped(true)
    const onReconnect = () => this.setDropped(false)
    // Kicked, room disposed, or the seat expired while dropped
    const onLeave = () => this.scene.start('Lobby')
    const room = this.room
    room.onStateChange(onStateChange)
    room.onDrop(onDrop)
    room.onReconnect(onReconnect)
    room.onLeave(onLeave)

    let disposed = false
    this.removeRoomHandlers = () => {
      if (disposed) return
      disposed = true
      room.onStateChange.remove(onStateChange)
      room.onDrop.remove(onDrop)
      room.onReconnect.remove(onReconnect)
      room.onLeave.remove(onLeave)
      this.disposeGame()
    }
    this.events.once('shutdown', this.removeRoomHandlers)
    // Switching games (Ctrl+←/→) destroys the scene without a shutdown
    this.events.once('destroy', () => {
      this.removeRoomHandlers()
      leaveCurrentRoom()
    })

    this.createGame()
    this.onRoomState()
  }

  private onRoomState() {
    const state = this.state
    if (!state) return

    // The game ended: back to picking the next one
    if (state.phase !== 'playing') {
      this.scene.start('GameSelectionRoom')
      return
    }

    this.renderState(state)
  }

  private setDropped(dropped: boolean) {
    this.dropped = dropped
    this.onDroppedChanged(dropped)
  }
}
