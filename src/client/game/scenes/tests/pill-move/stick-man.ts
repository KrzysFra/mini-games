import Phaser from "phaser"

class PillMove extends Phaser.Scene {
  line: Phaser.GameObjects.Line
  figure: Phaser.GameObjects.Container


  preload() {
  }

  create() {


    //  Our ellipse is centered at 400x300 and is 600px wide by 300px tall
    // const ellipse = new Phaser.Geom.Ellipse(screenWidth / 2, screenHeight / 2, 600, 300)

    // const graphics = this.add.graphics({ lineStyle: { width: 2, color: 0x00ff00 } })

    // graphics.strokeEllipseShape(ellipse, 64)

    this.figure = this.add.container(400, 300)

    const style = { lineStyle: { width: 4, color: 0xffffff } }

    // Torso + head (fixed part)
    const torso = this.add.graphics(style)
    torso.strokeCircle(0, -60, 20)
    torso.lineBetween(0, -40, 0, 30)

    // Limbs: drawn pointing straight down from (0,0) = the joint
    const makeLimb = (jointX, jointY, length) => {
      const limb = this.add.graphics(style)
      limb.lineBetween(0, 0, 0, length)
      limb.setPosition(jointX, jointY)
      return limb
    }

    const leftArm = makeLimb(0, -25, 35)
    const rightArm = makeLimb(0, -25, 35)
    const leftLeg = makeLimb(0, 30, 50)
    const rightLeg = makeLimb(0, 30, 50)

    this.figure.add([torso, leftArm, rightArm, leftLeg, rightLeg])

    // Animate: swing limbs back and forth (a walk cycle)
    this.tweens.add({
      targets: [leftArm, rightLeg],
      rotation: { from: -0.6, to: 0.6 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    })
    this.tweens.add({
      targets: [rightArm, leftLeg],
      rotation: { from: 0.6, to: -0.6 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    })

    // this.line = this.add.line(screenWidth / 2, screenHeight / 2, 0, 0, screenWidth, screenHeight, 0xff0000, 1)
    // this.line.setLineWidth(100, 11)

    // this.input.on('pointermove', (pointer: PointerEvent) => {
    //   this.figure.setPosition(pointer.x, pointer.y)
    // })
  }

}

export const configPillMove = {
  scene: PillMove
}