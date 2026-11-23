import Phaser from "phaser"

export class PillMan extends Phaser.GameObjects.Container {
  constructor(scene: Phaser.Scene, x?: number, y?: number) {
    super(scene, x, y)

    const style = { lineStyle: { width: 4, color: 0xffffff } }

    // Torso + head (fixed part)
    const torso = scene.add.graphics(style)
    torso.strokeCircle(0, -60, 20)
    torso.lineBetween(0, -40, 0, 30)

    const center = scene.add.circle(0, 0, 5, 0xff0000)

    this.add([torso, center])
  }
}

