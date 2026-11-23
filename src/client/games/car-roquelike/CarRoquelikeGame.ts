import { Predict, type InputHandle, type SimReconciler } from '@colyseus/sdk'
import { Cameras, GameObjects, Input, Math as PMath, Types } from 'phaser'
import { INPUT_BUTTONS } from '../../../shared/constants'
import { ARENA_HEIGHT, ARENA_WIDTH, CAR_LENGTH, CAR_MAX_SPEED, CAR_WIDTH } from '../../../shared/games/car-roquelike/constants'
import { MAP_BLOCKS } from '../../../shared/games/car-roquelike/map'
import {
  addCar, createCarWorld, destroyCarWorld, removeCar, stepCarWorld, toCarInput, writeCar,
  type CarInput, type CarSnapshot, type CarWorld, type GameInputLike,
} from '../../../shared/games/car-roquelike/physics'
import { textStyle } from '../../core/ui'
import { MiniGameScene } from '../MiniGameScene'

/** The fields of the server's room state this scene reads. */
interface CarView extends CarSnapshot {
  seat: number
}

interface PlayerView {
  name: string
}

interface RoomStateView {
  phase: string
  players: Map<string, PlayerView>
  cars: Map<string, CarView>
}

/** What the prediction steps: our own copy of the physics world (opaque to the predictor). */
interface PredictedWorld {
  physics: CarWorld
}

type CarPose = { x: number, y: number, angle: number }

interface CarSprite {
  container: GameObjects.Container
  name: GameObjects.Text
}

const CAR_COLORS = [0xd94f4f, 0x4f8fd9, 0x4fd97a, 0xe0c068, 0xb05fd9, 0x4fd9d0, 0xe08a3c, 0xe8e8e8]
const COLOR_OWN_OUTLINE = 0xffffff
const COLOR_GROUND = 0x30343a
const COLOR_GRID = 0x3b4047
const COLOR_BLOCK = 0x5b6169
const GRID_SIZE = 160

/** Camera zoom at rest and at top speed: zooms out as you go faster, like GTA 1/2. */
const ZOOM_STOPPED = 1
const ZOOM_TOP_SPEED = 0.6
/** Share of the gap to the target zoom closed per frame. */
const ZOOM_LERP = 0.04

/** Stick deflection ignored around the center (= brake); the rest is rescaled to 0..1. */
const STICK_DEADZONE = 0.15
/** Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping). */
const PAD_START = 9
const PAD_BACK = 8

/**
 * Stick position with a round deadzone: the direction is kept, the length rescaled so it starts
 * at 0 just outside the deadzone and reaches 1 at full deflection.
 */
const stickWithDeadzone = (x: number, y: number) => {
  const length = Math.hypot(x, y)
  if (length < STICK_DEADZONE) return { x: 0, y: 0 }
  const scaled = Math.min(1, (length - STICK_DEADZONE) / (1 - STICK_DEADZONE))
  return { x: (x / length) * scaled, y: (y / length) * scaled }
}

/**
 * car-roquelike: every player drives a car in a top-down arena; cars collide with each other
 * and the walls.
 *
 * The server runs the authoritative matter.js world (`CarRoquelikeSim`). This scene runs the same
 * shared physics locally to predict its own car: inputs apply immediately, and each server update
 * is adopted and the not-yet-confirmed inputs replayed (`predict.sim`). Other cars are drawn
 * interpolated between server updates. The camera is north-up and follows your car.
 */
export class CarRoquelikeGame extends MiniGameScene<RoomStateView> {
  private carWorld: CarWorld
  private predict: Predict
  private sim: SimReconciler<GameInputLike, CarPose, PredictedWorld> | undefined
  private gameInput: InputHandle<GameInputLike>
  /** Reused input map for stepping: only our own car gets an input on the client. */
  private stepInputs = new Map<string, CarInput>()

  private cars = new Map<string, CarSprite>()
  private worldLayer: GameObjects.Layer
  private uiLayer: GameObjects.Layer
  private uiCamera: Cameras.Scene2D.Camera
  private statusText: GameObjects.Text
  /** HUD line: whether a gamepad is detected (and which), to debug controller setups in-game. */
  private padText: GameObjects.Text
  private keys: Record<'up' | 'down' | 'left' | 'right' | 'w' | 'a' | 's' | 'd' | 'space', Input.Keyboard.Key>
  private following = false

  constructor() {
    // Gamepad input is off by default in Phaser; this scene turns it on for itself. Scene settings
    // read `input` at runtime (scene/Settings.js), but Phaser 4's SettingsConfig type lacks it.
    const config: Types.Scenes.SettingsConfig & { input: { gamepad: boolean } } = {
      key: 'CarRoquelikeGame', input: { gamepad: true },
    }
    super(config)
  }

  protected createGame() {
    this.cars = new Map()
    this.sim = undefined
    this.following = false
    this.carWorld = createCarWorld()

    // World (zoomed, scrolling) and HUD (fixed) live on separate cameras
    this.worldLayer = this.add.layer()
    this.uiLayer = this.add.layer()
    this.drawArena()

    this.statusText = this.add.text(this.scale.width / 2, 40, '', textStyle(32, '#d9776c')).setOrigin(0.5)
    const help = this.add.text(this.scale.width / 2, this.scale.height - 40,
      'Point where to drive: left stick or WASD / arrows (let go to brake)  ·  A / Space handbrake  ·  Start / Escape to stop',
      textStyle(26, '#9fb3bb')).setOrigin(0.5)
    this.padText = this.add.text(24, 20, '', textStyle(22, '#9fb3bb'))
    this.uiLayer.add([this.statusText, help, this.padText])

    const camera = this.cameras.main
    camera.setBounds(0, 0, ARENA_WIDTH, ARENA_HEIGHT).setBackgroundColor(0x1d2024).ignore(this.uiLayer)
    this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height).ignore(this.worldLayer)

    const K = Input.Keyboard.KeyCodes
    this.keys = this.input.keyboard.addKeys({
      up: K.UP, down: K.DOWN, left: K.LEFT, right: K.RIGHT, w: K.W, a: K.A, s: K.S, d: K.D, space: K.SPACE,
    }) as typeof this.keys

    this.input.keyboard.on('keydown-ESC', (e: KeyboardEvent) => {
      if (e.repeat) return
      this.sendEscape('Escape key')
    })
    // Start (or Back) on pad1 does the same as Escape
    this.input.gamepad?.on('down', (pad: Input.Gamepad.Gamepad, button: Input.Gamepad.Button) => {
      if (pad === this.input.gamepad.pad1 && (button.index === PAD_START || button.index === PAD_BACK)) {
        this.sendEscape(`gamepad button ${button.index}`)
      }
    })

    // Remote cars: interpolated between server updates (angle separately, so it lerps the short way)
    this.predict = Predict.get(this.room)
    this.predict.attachAll('cars', { fields: ['x', 'y'], mode: 'lerp', delay: 100 })
    this.predict.attachAll('cars', { fields: ['angle'], mode: 'lerp', delay: 100, angle: true })
    // Same handle for the room's whole life (the SDK caches it). Reliable: WebSocket has no
    // unreliable channel, so 'unreliable' would only add redundant copies (and a console warning)
    this.gameInput = this.room.input<GameInputLike>({ mode: 'reliable' })
  }

  private drawArena() {
    const ground = this.add.graphics()
    ground.fillStyle(COLOR_GROUND).fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT)
    ground.lineStyle(2, COLOR_GRID)
    for (let x = 0; x <= ARENA_WIDTH; x += GRID_SIZE) ground.lineBetween(x, 0, x, ARENA_HEIGHT)
    for (let y = 0; y <= ARENA_HEIGHT; y += GRID_SIZE) ground.lineBetween(0, y, ARENA_WIDTH, y)
    this.worldLayer.add(ground)

    for (const block of MAP_BLOCKS) {
      this.worldLayer.add(this.add.rectangle(block.x, block.y, block.width, block.height, COLOR_BLOCK)
        .setStrokeStyle(4, 0x15171a))
    }
  }

  /** Start predicting our own car once the server has given us one. */
  private startPrediction() {
    const me = this.room.sessionId
    this.sim = this.predict.sim<GameInputLike, CarPose, PredictedWorld>({
      input: this.gameInput,
      world: { physics: this.carWorld },
      // Exactly what the server does for one tick; other cars just coast until the next update
      step: (ctx, world, command) => {
        this.stepInputs.set(me, toCarInput(command, this.stepInputs.get(me)))
        stepCarWorld(world.physics, this.stepInputs, ctx.subSteps, ctx.subDtMs)
      },
      // Server truth for every car, then the predictor replays our unconfirmed inputs on top
      adopt: world => this.adoptServerCars(world.physics),
      pose: world => {
        const body = world.physics.cars.get(me)
        return body
          ? { x: body.position.x, y: body.position.y, angle: body.angle }
          : { x: 0, y: 0, angle: 0 }
      },
      smoothMs: 65,
    })
  }

  /** Make the local physics world match the server's cars exactly. */
  private adoptServerCars(physics: CarWorld) {
    const serverCars = this.state?.cars
    if (!serverCars) return
    for (const id of [...physics.cars.keys()]) {
      if (!serverCars.has(id)) removeCar(physics, id)
    }
    for (const [id, car] of serverCars) {
      const body = physics.cars.get(id)
      if (body) writeCar(body, car)
      else addCar(physics, id, car.seat, car)
    }
  }

  protected renderState(state: RoomStateView) {
    // Sprites for cars that appeared, gone for cars that left (positions are set every frame)
    for (const [id, car] of state.cars) {
      if (!this.cars.has(id)) this.cars.set(id, this.createCarSprite(id, car.seat))
    }
    for (const [id, sprite] of this.cars) {
      if (!state.cars.has(id)) {
        sprite.container.destroy()
        sprite.name.destroy()
        this.cars.delete(id)
      }
    }

    if (!this.sim && state.cars.has(this.room.sessionId)) {
      this.adoptServerCars(this.carWorld)
      this.startPrediction()
    }
  }

  private createCarSprite(id: string, seat: number): CarSprite {
    const isMe = id === this.room.sessionId
    const color = CAR_COLORS[seat % CAR_COLORS.length]
    // Drawn facing +x (angle 0), like the physics body
    const body = this.add.rectangle(0, 0, CAR_LENGTH, CAR_WIDTH, color)
      .setStrokeStyle(isMe ? 5 : 3, isMe ? COLOR_OWN_OUTLINE : 0x000000)
    const windshield = this.add.rectangle(CAR_LENGTH * 0.12, 0, CAR_LENGTH * 0.18, CAR_WIDTH * 0.75, 0x9fd3e8)
    const rearWindow = this.add.rectangle(-CAR_LENGTH * 0.3, 0, CAR_LENGTH * 0.1, CAR_WIDTH * 0.7, 0x6f93a3)
    const container = this.add.container(0, 0, [body, windshield, rearWindow])

    const playerName = this.state?.players.get(id)?.name ?? ''
    const name = this.add.text(0, 0, playerName, { ...textStyle(22, isMe ? '#e0c068' : '#ffffff'), stroke: '#000000', strokeThickness: 4 })
      .setOrigin(0.5)
    this.worldLayer.add([container, name])
    return { container, name }
  }

  update(time: number) {
    if (!this.predict) return

    // Send exactly the input steps that are due this frame (each one is predicted as it's sent),
    // then read render positions
    const due = this.predict.tick(time)
    for (let i = 0; i < due; i++) {
      if (this.dropped) break
      this.stageInput()
      this.gameInput.send()
    }

    this.positionCars()
    this.updateCamera()
    this.updatePadStatus()
  }

  private updatePadStatus() {
    const pad = this.input.gamepad?.pad1
    const status =
      !window.isSecureContext ? 'Gamepads need localhost or https'
        : !this.input.gamepad ? 'Gamepads not supported'
          : pad?.connected ? `Gamepad: ${pad.id}`
            // Browsers only reveal a pad after one of its buttons is pressed with the page focused
            : 'No gamepad — press a button on it'
    if (this.padText.text !== status) this.padText.setText(status)
  }

  /** Leaving the game; in the sandbox, once everyone has, all cars respawn. Logged with its source. */
  private sendEscape(source: string) {
    if (this.dropped) return
    console.info(`[car-roquelike] escape sent (${source})`)
    this.room.send('escape')
  }

  /**
   * The direction the player wants to drive in, in screen space (= world space, the camera is
   * north-up): keyboard, D-pad and pad1's left stick added up, at most length 1. The shared physics
   * steers the car toward it (`resolveCarControls`); length 0 brakes.
   */
  private stageInput() {
    const k = this.keys
    let x = (k.right.isDown || k.d.isDown ? 1 : 0) - (k.left.isDown || k.a.isDown ? 1 : 0)
    let y = (k.down.isDown || k.s.isDown ? 1 : 0) - (k.up.isDown || k.w.isDown ? 1 : 0)
    let handbrake = k.space.isDown

    // pad1: the first gamepad this tab sees. Browsers only report a pad after one of its buttons
    // is pressed while the page has focus.
    const pad = this.input.gamepad?.pad1
    if (pad?.connected) {
      // Raw axes (Phaser's leftStick applies a square per-axis threshold); +y is down, like the screen
      const stick = stickWithDeadzone(pad.axes[0]?.value ?? 0, pad.axes[1]?.value ?? 0)
      x += stick.x + (pad.right ? 1 : 0) - (pad.left ? 1 : 0)
      y += stick.y + (pad.down ? 1 : 0) - (pad.up ? 1 : 0)
      handbrake ||= pad.A
    }

    // Diagonals (two keys, or stick + key) would be longer than 1
    const length = Math.hypot(x, y)
    if (length > 1) {
      x /= length
      y /= length
    }

    const data = this.gameInput.data
    data.x = x
    data.y = y
    data.buttons = handbrake ? INPUT_BUTTONS.ACTION : 0
  }

  private positionCars() {
    const state = this.state
    if (!state) return
    const me = this.room.sessionId

    for (const [id, sprite] of this.cars) {
      let x: number, y: number, angle: number
      if (id === me && this.sim) {
        const pose = this.sim.pose()
        x = pose.x; y = pose.y; angle = pose.angle
      } else {
        const car = state.cars.get(id)
        if (!car) continue
        x = this.predict.value(car, 'x')
        y = this.predict.value(car, 'y')
        angle = this.predict.value(car, 'angle')
      }
      sprite.container.setPosition(x, y).setRotation(angle)
      sprite.name.setPosition(x, y - CAR_LENGTH * 0.75)
    }
  }

  /** North-up, follows our car, zooms out with speed. */
  private updateCamera() {
    const mine = this.cars.get(this.room.sessionId)
    if (!mine) return
    const camera = this.cameras.main
    if (!this.following) {
      camera.startFollow(mine.container, true, 0.12, 0.12)
      this.following = true
    }

    const body = this.carWorld.cars.get(this.room.sessionId)
    const speed = body ? Math.hypot(body.velocity.x, body.velocity.y) : 0
    const targetZoom = PMath.Linear(ZOOM_STOPPED, ZOOM_TOP_SPEED, PMath.Clamp(speed / CAR_MAX_SPEED, 0, 1))
    camera.setZoom(PMath.Linear(camera.zoom, targetZoom, ZOOM_LERP))
  }

  protected onDroppedChanged(dropped: boolean) {
    this.statusText.setText(dropped ? 'Connection lost, reconnecting…' : '')
  }

  protected disposeGame() {
    this.sim?.dispose()
    this.sim = undefined
    this.predict?.dispose()
    this.predict = undefined
    if (this.carWorld) destroyCarWorld(this.carWorld)
    this.carWorld = undefined
  }
}
