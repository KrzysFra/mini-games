import { Scene } from 'phaser'
import { leaveCurrentRoom } from '../../core/session'

/** Placeholder for the room players are in after creating or joining one from the Lobby. */
export class GameSelectionRoom extends Scene {
  constructor() {
    super('GameSelectionRoom')
  }

  create() {
    const { width } = this.scale

    this.add.text(width / 2, 90, 'GameSelectionRoom', {
      fontFamily: 'Arial Black', fontSize: 72, color: '#ffffff',
      stroke: '#000000', strokeThickness: 8,
    }).setOrigin(0.5)

    // Switching games (Ctrl+←/→) destroys the scene without a shutdown
    this.events.once('destroy', leaveCurrentRoom)
  }
}
