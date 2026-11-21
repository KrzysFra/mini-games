import Phaser from "phaser"

class Example extends Phaser.Scene {
  player: Phaser.Types.Physics.Arcade.ImageWithDynamicBody
  cursors: { left: any; right: any; up: any; down: any; space?: Phaser.Input.Keyboard.Key; shift?: Phaser.Input.Keyboard.Key }

  preload() {
    // this.load.setBaseURL('https://cdn.phaserfiles.com/v410')
    this.load.image('block', 'assets/block.png')
  }

  create() {
    this.cursors = this.input.keyboard.createCursorKeys()

    this.player = this.physics.add.image(400, 300, 'block')

    this.player.setCollideWorldBounds(true)
  }

  update() {
    this.player.setVelocity(0)

    if (this.cursors.left.isDown) {
      this.player.setVelocityX(-300)
    }
    else if (this.cursors.right.isDown) {
      this.player.setVelocityX(300)
    }

    if (this.cursors.up.isDown) {
      this.player.setVelocityY(-300)
    }
    else if (this.cursors.down.isDown) {
      this.player.setVelocityY(300)
    }
  }
}

export const configCursorKeys = {
  physics: {
    default: 'arcade',
    arcade: {
      debug: true
    }
  },
  scene: Example
}
