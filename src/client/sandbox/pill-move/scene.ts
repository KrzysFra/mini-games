
import Phaser from "phaser"
import { PillMan } from "./pill-man"

class PillMove extends Phaser.Scene {
  player: Phaser.GameObjects.Container

  test: Phaser.GameObjects.Container

  preload() {
  }

  create() {
    this.player = this.add.existing(new PillMan(this, 200, 200))
  }

}

export const configPillMove = {
  scene: PillMove
}
