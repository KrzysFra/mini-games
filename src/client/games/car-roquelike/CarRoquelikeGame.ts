import { Predict, type InputHandle, type SimReconciler } from '@colyseus/sdk'
import { Cameras, GameObjects, Input, Types } from 'phaser'
import { MAX_PLAYERS_PER_ROOM, TICK_RATE } from '@shared/constants'
import { CAR_LENGTH, CAR_WIDTH, WIN_FADE_TICKS, WIN_TEXT_TICKS } from '@shared/games/car-roquelike/constants'
import { toCarInput, type CarInput, type GameInputLike } from '@shared/games/car-roquelike/controls'
import { COUNTDOWN_TICKS, destructionFrontS } from '@shared/games/car-roquelike/destruction'
import { MAP_BLOCKS } from '@shared/games/car-roquelike/map'
import { MAX_OBSTACLES, OBSTACLE_KINDS, OBSTACLE_SEGMENT, obstacleWeight, type ObstacleKind } from '@shared/games/car-roquelike/obstacles'
import {
  addCar, addObstacle, createCarWorld, destroyCarWorld, FIRST_OBSTACLE_SEGMENT, maintainRoad, nextObstacleSegment,
  removeCar, removeObstacle, stepCarRound, useRoadSeed, writeCar, type CarSnapshot, type CarWorld,
} from '@shared/games/car-roquelike/physics'
import { CAMERA_ZOOM, cameraCenter } from '@shared/games/car-roquelike/camera'
import { SANDBOX_GAME, SANDBOX_ROOM } from '@core/sandbox'
import { textStyle } from '@core/ui'
import { MiniGameParent } from '../MiniGameScene'
import { CpuDrivers } from './CpuDrivers'
import { DestructionView } from './DestructionView'
import { addDriveKeys, PAD_BACK, PAD_START, readDriveInput } from './playerInput'
import { COLOR_DIRT, RoadView } from './RoadView'

/** The fields of the server's room state this scene reads. */
interface CarView extends CarSnapshot {
  seat: number
  eliminated: boolean
  /** The input the server last applied to the car. */
  inX: number
  inY: number
  inButtons: number
}

/** An obstacle car (`ObstacleCar` in the room state). */
interface ObstacleView extends CarSnapshot {
  kind: string
  speed: number
  lane: number
  slot: number
}

interface RoomStateView {
  phase: string
  players: Map<string, { name: string }>
  cars: Map<string, CarView>
  obstacles: Map<string, ObstacleView>
  carRound: number
  carRoundTick: number
  carWinner: string
  carWinnerName: string
  carWinTick: number
  roadSeed: number
}

/**
 * What the prediction steps: our own copy of the physics world (opaque to the predictor) and the
 * round's tick count, which drives the countdown and the destruction front.
 */
interface PredictedWorld {
  physics: CarWorld
  roundTick: number
}

/**
 * What the predictor interpolates and smooths: every car's pose, in a fixed slot per seat (the SDK
 * takes the field set from the first pose, so it can't follow cars coming and going), every
 * obstacle's in its slot likewise, plus the round tick, so the front is drawn smoothly at our
 * predicted time.
 */
type WorldPose = Record<string, number>

interface PoseFields { x: string, y: string, angle: string }
/** Pose field names of each seat's slot. */
const SEAT_FIELDS: PoseFields[] = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, seat) => ({ x: `x${seat}`, y: `y${seat}`, angle: `a${seat}` }))
const seatFields = (seat: number) => SEAT_FIELDS[seat % SEAT_FIELDS.length]
/** Pose field names of each obstacle slot. */
const OBSTACLE_FIELDS: PoseFields[] = Array.from({ length: MAX_OBSTACLES }, (_, slot) => ({ x: `ox${slot}`, y: `oy${slot}`, angle: `oa${slot}` }))
const obstacleFields = (slot: number) => OBSTACLE_FIELDS[slot % OBSTACLE_FIELDS.length]

const CAR_COLORS = [0xd94f4f, 0x4f8fd9, 0x4fd97a, 0xe0c068, 0xb05fd9, 0x4fd9d0, 0xe08a3c, 0xe8e8e8]
/** Our car blinks during the countdown: this long per on/off phase, at this alpha when off. */
const OWN_BLINK_MS = 150
const OWN_BLINK_ALPHA = 0.15
const COLOR_BLOCK = 0x5b6169
/** Teleports beyond this (a round restart) are cut instead of smoothed. */
const SNAP_DISTANCE = 500
/** The world fades in from black this long (ms) at the start of a round, into the running start. */
const FADE_IN_MS = 1200
/**
 * The obstacle weights bar (HUD, top right, vertical): size, corner radius, distance from the
 * screen edges. Its width is per 1 of total weight (the spawn rate): it widens to the left.
 */
const WEIGHT_BAR_WIDTH = 28
const WEIGHT_BAR_HEIGHT = 360
const WEIGHT_BAR_RADIUS = 12
const WEIGHT_BAR_MARGIN = 24
/**
 * After a win, the world fades to black this long (ms): a little under the server's
 * `WIN_FADE_TICKS`, so it's black by the time the next round starts.
 */
const WIN_FADE_OUT_MS = WIN_FADE_TICKS / TICK_RATE * 1000 * 0.9

/**
 * car-roquelike: every player drives a car top-down along a randomly generated road (`road.ts`,
 * a new one each round, from `roadSeed`) surrounded by endless dirt (which halves top speed); cars
 * collide with each other. After a countdown the world collapses into the void from the road's
 * start, moving along the road at 95% of top speed (`destruction.ts`); a car caught by it, or
 * leaving the shared camera's view (`camera.ts`), is eliminated, and once everyone is, the round restarts.
 *
 * The ground is drawn by `RoadView` (dirt, road pieces culled to the view) and `DestructionView`
 * (the void and its crumbling edge, derived from the front).
 *
 * The server runs the authoritative matter.js world (`CarRoquelikeSim`). This scene runs the same
 * shared physics locally to predict its own car: inputs apply immediately, and each server update
 * is adopted and the not-yet-confirmed inputs replayed (`predict.sim`). Other cars are predicted in
 * the same world, repeating the input the server last applied to them (`Car.inX/inY/inButtons`),
 * and every car is drawn from it (interpolated and correction-smoothed by the SDK), so what you see
 * is what you hit. Until our own car exists, other cars are drawn interpolated between server updates.
 */
export class CarRoquelikeGame extends MiniGameParent<RoomStateView> {
  private carWorld: CarWorld
  private predict: Predict
  private sim: SimReconciler<GameInputLike, WorldPose, PredictedWorld> | undefined
  private gameInput: InputHandle<GameInputLike>
  /** Reused input map for stepping: ours from the command, others' last server input (set on adopt). */
  private stepInputs = new Map<string, CarInput>()
  private wireScratch: GameInputLike = { x: 0, y: 0, buttons: 0 }
  private eliminatedScratch: string[] = []
  /** Reused pose; a seat's slot keeps its last value while no car is in it. */
  private worldPose: WorldPose = {
    roundTick: 0,
    ...Object.fromEntries([...SEAT_FIELDS, ...OBSTACLE_FIELDS].flatMap(f => [[f.x, 0], [f.y, 0], [f.angle, 0]])),
  }

  private cars = new Map<string, GameObjects.Container>()
  private obstacleSprites = new Map<string, GameObjects.Container>()
  private roadView: RoadView
  private destructionView: DestructionView
  /** The round tick drawn last frame (undefined before the first state): going back = a new round. */
  private lastRoundTick: number | undefined
  /** Scratch point for the camera's spot on the road. */
  private cameraPoint = { x: 0, y: 0, heading: 0, s: 0 }
  private worldLayer: GameObjects.Layer
  private uiLayer: GameObjects.Layer
  private uiCamera: Cameras.Scene2D.Camera
  private statusText: GameObjects.Text
  private countdownText: GameObjects.Text
  private eliminatedText: GameObjects.Text
  /** "<name> has won!!" while a round's winner is shown. */
  private winText: GameObjects.Text
  /** The world is fading (or faded) to black after a win. */
  private winFadingOut = false
  /** HUD line: whether a gamepad is detected (and which), to debug controller setups in-game. */
  private padText: GameObjects.Text
  /** Sandbox only: CPU drivers hosted by this tab (extra connections that drive like players). */
  private cpuDrivers: CpuDrivers | undefined
  private keys: ReturnType<typeof addDriveKeys>
  /** HUD bar (top right): the obstacle kinds' current share of spawns (`OBSTACLE_WEIGHTS`). */
  private weightBar: GameObjects.Graphics
  /** The weights the bar was last drawn for (redrawn only when they change). */
  private weightBarKey: string | undefined
  /** The server's obstacle spawning, followed here: the next segment to roll, on road `weightSeed`. */
  private weightSegment = FIRST_OBSTACLE_SEGMENT
  private weightSeed: number | undefined

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
    this.obstacleSprites = new Map()
    this.sim = undefined
    this.carWorld = createCarWorld()

    // World (zoomed, scrolling) and HUD (fixed) live on separate cameras
    this.worldLayer = this.add.layer()
    this.uiLayer = this.add.layer()
    // Bottom to top: dirt and road, the void, buildings (cars are added above as they come)
    this.roadView = new RoadView(this, this.worldLayer)
    this.destructionView = new DestructionView(this, this.worldLayer)
    for (const block of MAP_BLOCKS) {
      this.worldLayer.add(this.add.rectangle(block.x, block.y, block.width, block.height, COLOR_BLOCK)
        .setStrokeStyle(4, 0x15171a))
    }
    this.createHud()

    const camera = this.cameras.main
    camera.setBackgroundColor(COLOR_DIRT).setZoom(CAMERA_ZOOM).ignore(this.uiLayer)
    // The world (not the HUD) fades in from black, into the running start
    camera.fadeIn(FADE_IN_MS, 0, 0, 0)
    this.lastRoundTick = undefined
    this.winFadingOut = false
    this.uiCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height).ignore(this.worldLayer)

    this.keys = addDriveKeys(this)
    this.input.keyboard.on('keydown-ESC', (e: KeyboardEvent) => {
      if (!e.repeat) this.sendEscape('Escape key')
    })
    // Start (or Back) on pad1 does the same as Escape
    this.input.gamepad?.on('down', (pad: Input.Gamepad.Gamepad, button: Input.Gamepad.Button) => {
      if (pad === this.input.gamepad.pad1 && (button.index === PAD_START || button.index === PAD_BACK)) {
        this.sendEscape(`gamepad button ${button.index}`)
      }
    })

    // Remote cars: interpolated between server updates (angle separately, so it lerps the short way)
    this.predict = Predict.get(this.room)
    this.predict.attachAll('cars', { fields: ['x', 'y'], mode: 'lerp', delay: 100, snap: SNAP_DISTANCE })
    this.predict.attachAll('cars', { fields: ['angle'], mode: 'lerp', delay: 100, angle: true })
    this.predict.attachAll('obstacles', { fields: ['x', 'y'], mode: 'lerp', delay: 100, snap: SNAP_DISTANCE })
    this.predict.attachAll('obstacles', { fields: ['angle'], mode: 'lerp', delay: 100, angle: true })
    // Same handle for the room's whole life (the SDK caches it). Reliable: WebSocket has no
    // unreliable channel, so 'unreliable' would only add redundant copies (and a console warning)
    this.gameInput = this.room.input<GameInputLike>({ mode: 'reliable' })

    if (SANDBOX_GAME && this.room.name === SANDBOX_ROOM) this.cpuDrivers = new CpuDrivers(this.room)
  }

  private createHud() {
    const { width, height } = this.scale
    this.statusText = this.add.text(width / 2, 40, '', textStyle(32, '#d9776c')).setOrigin(0.5)
    const help = this.add.text(width / 2, height - 40,
      'Point where to drive: left stick or WASD / arrows (let go to brake)  ·  A / Space handbrake  ·  Start / Escape to stop',
      textStyle(26, '#9fb3bb')).setOrigin(0.5)
    this.padText = this.add.text(24, 20, '', textStyle(22, '#9fb3bb'))
    this.countdownText = this.add.text(width / 2, height / 2 - 160, '',
      { ...textStyle(160, '#ffffff'), stroke: '#000000', strokeThickness: 12 }).setOrigin(0.5)
    this.eliminatedText = this.add.text(width / 2, 110, '',
      { ...textStyle(40, '#d9776c'), stroke: '#000000', strokeThickness: 6 }).setOrigin(0.5)
    this.winText = this.add.text(width / 2, height / 2 - 160, '',
      { ...textStyle(110, '#e0c068'), stroke: '#000000', strokeThickness: 12 }).setOrigin(0.5)
    this.uiLayer.add([this.statusText, help, this.padText, this.countdownText, this.eliminatedText, this.winText])

    this.weightBar = this.add.graphics()
    this.weightBarKey = undefined
    this.weightSegment = FIRST_OBSTACLE_SEGMENT
    this.weightSeed = undefined
    this.uiLayer.add(this.weightBar)
  }

  /**
   * The obstacle weights in use for spawning right now, as a bar: at the last segment rolled
   * (followed with `nextObstacleSegment`, like the server's `spawnObstacles`, at our front).
   */
  private updateWeightBar(frontS: number) {
    const road = this.carWorld.road
    if (road.seed !== this.weightSeed) {
      this.weightSeed = road.seed
      this.weightSegment = FIRST_OBSTACLE_SEGMENT
    }
    this.weightSegment = nextObstacleSegment(road, frontS, this.weightSegment)
    // (Before any obstacle spawns: the weights the first ones will get)
    const distance = Math.max(this.weightSegment - 1, FIRST_OBSTACLE_SEGMENT) * OBSTACLE_SEGMENT
    const kinds = Object.keys(OBSTACLE_KINDS) as ObstacleKind[]
    const weights = kinds.map(kind => obstacleWeight(kind, distance))
    const key = weights.join()
    if (key === this.weightBarKey) return
    this.weightBarKey = key

    const total = weights.reduce((sum, w) => sum + w, 0)
    const bar = this.weightBar.clear()
    // As wide as the spawn rate (nothing spawning: no bar)
    const barWidth = total * WEIGHT_BAR_WIDTH
    if (barWidth <= 0) return
    const x0 = this.scale.width - WEIGHT_BAR_MARGIN - barWidth
    const y0 = WEIGHT_BAR_MARGIN
    const bottom = y0 + WEIGHT_BAR_HEIGHT
    const radius = Math.min(WEIGHT_BAR_RADIUS, barWidth / 2)
    bar.fillStyle(0x000000, 0.5).fillRoundedRect(x0, y0, barWidth, WEIGHT_BAR_HEIGHT, radius)
    // Kinds top to bottom. Each one is filled from its top down to the bar's bottom (the next ones
    // paint over the rest), so only the first needs rounded top corners and all share the bottom's.
    let y = y0
    let first = true
    kinds.forEach((kind, i) => {
      const height = total > 0 ? weights[i] / total * WEIGHT_BAR_HEIGHT : 0
      if (height <= 0) return
      const r = Math.min(radius, (bottom - y) / 2)
      bar.fillStyle(OBSTACLE_KINDS[kind].color, 1)
        .fillRoundedRect(x0, y, barWidth, bottom - y, { tl: first ? r : 0, tr: first ? r : 0, bl: r, br: r })
      first = false
      y += height
    })
    bar.lineStyle(4, 0x000000, 1).strokeRoundedRect(x0, y0, barWidth, WEIGHT_BAR_HEIGHT, radius)
  }

  /** Start predicting (our car, and the others with it) once the server has given us a car. */
  private startPrediction() {
    const me = this.room.sessionId
    this.sim = this.predict.sim<GameInputLike, WorldPose, PredictedWorld>({
      input: this.gameInput,
      world: { physics: this.carWorld, roundTick: this.state?.carRoundTick ?? 0 },
      // Exactly what the server does for one tick (countdown, physics, elimination); other cars
      // repeat their last known input. The round tick is predicted along with the inputs.
      step: (ctx, world, command) => {
        this.stepInputs.set(me, toCarInput(command, this.stepInputs.get(me)))
        stepCarRound(world.physics, this.stepInputs, world.roundTick, ctx.subSteps, ctx.subDtMs, this.eliminatedScratch)
        world.roundTick++
      },
      // Server truth for every car and the round tick, then the predictor replays our
      // unconfirmed inputs on top
      adopt: world => {
        this.adoptServerCars(world.physics) // (the road too: a new one comes with each round)
        this.adoptOtherInputs()
        world.roundTick = this.state?.carRoundTick ?? 0
      },
      pose: world => {
        const pose = this.worldPose
        const cars = this.state?.cars
        for (const [id, body] of world.physics.cars) {
          const car = cars?.get(id)
          if (!car) continue
          const f = seatFields(car.seat)
          pose[f.x] = body.position.x
          pose[f.y] = body.position.y
          pose[f.angle] = body.angle
        }
        for (const obstacle of world.physics.obstacles.values()) {
          const f = obstacleFields(obstacle.slot)
          pose[f.x] = obstacle.body.position.x
          pose[f.y] = obstacle.body.position.y
          pose[f.angle] = obstacle.body.angle
        }
        pose.roundTick = world.roundTick
        return pose
      },
      smoothMs: 65,
      // A round restart (or a car joining) moves a car across the map: cut, don't glide
      snap: SNAP_DISTANCE,
    })
  }

  /** Make the local physics world match the server's cars exactly (eliminated cars are gone). */
  private adoptServerCars(physics: CarWorld) {
    const state = this.state
    if (!state) return
    useRoadSeed(physics, state.roadSeed)
    for (const id of physics.cars.keys()) {
      if (!state.cars.get(id) || state.cars.get(id).eliminated) removeCar(physics, id)
    }
    for (const [id, car] of state.cars) {
      if (car.eliminated) continue
      const body = physics.cars.get(id)
      if (body) writeCar(body, car)
      else addCar(physics, id, car.seat, car)
    }
    for (const id of physics.obstacles.keys()) {
      if (!state.obstacles.has(id)) removeObstacle(physics, id)
    }
    for (const [id, car] of state.obstacles) {
      const obstacle = physics.obstacles.get(id)
      // (Ids repeat from round to round: a different obstacle may come under a known id)
      if (obstacle && obstacle.slot === car.slot && obstacle.kind === car.kind && obstacle.lane === car.lane) {
        writeCar(obstacle.body, car)
        obstacle.speed = car.speed
      } else {
        addObstacle(physics, id, { kind: car.kind as ObstacleKind, speed: car.speed, lane: car.lane }, car.slot, car)
      }
    }
  }

  /** Other cars repeat the input the server last applied to them until the next update. */
  private adoptOtherInputs() {
    const me = this.room.sessionId
    const cars = this.state?.cars
    if (!cars) return
    for (const id of this.stepInputs.keys()) {
      if (id !== me && !cars.has(id)) this.stepInputs.delete(id)
    }
    const wire = this.wireScratch
    for (const [id, car] of cars) {
      if (id === me) continue
      wire.x = car.inX
      wire.y = car.inY
      wire.buttons = car.inButtons
      this.stepInputs.set(id, toCarInput(wire, this.stepInputs.get(id)))
    }
  }

  protected renderState(state: RoomStateView) {
    // Sprites for cars that appeared, gone for cars that left (positions are set every frame)
    for (const [id, car] of state.cars) {
      if (!this.cars.has(id)) this.cars.set(id, this.createCarSprite(car.seat))
    }
    for (const [id, sprite] of this.cars) {
      if (!state.cars.has(id)) {
        sprite.destroy()
        this.cars.delete(id)
      }
    }

    for (const [id, sprite] of this.obstacleSprites) {
      if (state.obstacles.get(id)?.kind !== sprite.getData('kind')) {
        sprite.destroy()
        this.obstacleSprites.delete(id)
      }
    }
    for (const [id, obstacle] of state.obstacles) {
      if (!this.obstacleSprites.has(id)) this.obstacleSprites.set(id, this.createObstacleSprite(obstacle.kind as ObstacleKind))
    }

    if (!this.sim && state.cars.has(this.room.sessionId)) {
      this.adoptServerCars(this.carWorld)
      this.startPrediction()
    }
  }

  /**
   * Whether a car is out of the round: the server says so, or the prediction already dropped it
   * into the void.
   */
  private isOut(id: string, car: CarView): boolean {
    return car.eliminated || (!!this.sim && !this.carWorld.cars.has(id))
  }

  /** A car's shape (body, windshield, rear window), drawn facing +x (angle 0) like the physics body. */
  private createCarShape(color: number, outlineWidth: number, outlineColor: number): GameObjects.Container {
    const body = this.add.rectangle(0, 0, CAR_LENGTH, CAR_WIDTH, color).setStrokeStyle(outlineWidth, outlineColor)
    const windshield = this.add.rectangle(CAR_LENGTH * 0.12, 0, CAR_LENGTH * 0.18, CAR_WIDTH * 0.75, 0x9fd3e8)
    const rearWindow = this.add.rectangle(-CAR_LENGTH * 0.3, 0, CAR_LENGTH * 0.1, CAR_WIDTH * 0.7, 0x6f93a3)
    return this.add.container(0, 0, [body, windshield, rearWindow])
  }

  /** An obstacle car: colored by its kind, no name. */
  private createObstacleSprite(kind: ObstacleKind): GameObjects.Container {
    const container = this.createCarShape(OBSTACLE_KINDS[kind]?.color ?? 0x808080, 3, 0x000000)
      .setData('kind', kind).setVisible(false)
    this.worldLayer.add(container)
    return container
  }

  /** A player's car: colored by its seat, the same for everyone (ours blinks in the countdown). */
  private createCarSprite(seat: number): GameObjects.Container {
    const container = this.createCarShape(CAR_COLORS[seat % CAR_COLORS.length], 3, 0x000000)
    this.worldLayer.add(container)
    return container
  }

  update(time: number) {
    if (!this.predict) return

    // Send exactly the input steps that are due this frame (each one is predicted as it's sent),
    // then read render positions
    const due = this.predict.tick(time)
    for (let i = 0; i < due && !this.dropped; i++) {
      readDriveInput(this.keys, this.input.gamepad?.pad1, this.gameInput.data)
      this.gameInput.send()
    }

    // Once predicting, everything is drawn at our predicted time: the round tick (so the front)
    // and every car (where our physics world has it: what we collide with). Else the server's.
    const state = this.state
    const pose = this.sim?.pose()
    const roundTick = pose ? pose.roundTick : (state?.carRoundTick ?? 0)
    const frontS = destructionFrontS(roundTick)
    if (state) {
      // A new round (the tick went back): fade in again. (Small steps back are prediction corrections.)
      if (this.lastRoundTick !== undefined && roundTick < this.lastRoundTick - TICK_RATE) {
        this.cameras.main.fadeIn(FADE_IN_MS, 0, 0, 0)
      }
      this.lastRoundTick = roundTick
      this.updateWinFade(state)
      // This round's road, generated ahead of the leading car (the predicted world has every car)
      useRoadSeed(this.carWorld, state.roadSeed)
      maintainRoad(this.carWorld, frontS)
      this.roadView.sync(this.carWorld.road, frontS)
      this.positionObstacles(state, pose)
      this.positionCars(state, pose, roundTick < COUNTDOWN_TICKS && Math.floor(time / OWN_BLINK_MS) % 2 === 1)
      this.updateCamera(frontS)
      this.updateWeightBar(frontS)
    }
    const view = this.cameras.main.worldView
    this.roadView.updateView(view)
    if (state) this.destructionView.update(this.carWorld.road, frontS, view)

    this.updateRoundHud(roundTick)
    this.updatePadStatus()
    this.cpuDrivers?.update(time)
  }

  /**
   * A round with a winner: once its text has shown `WIN_TEXT_TICKS` (server time, so everyone
   * fades together), the world fades to black until the server restarts the round. If the
   * winner is cleared and the new round's tick jump went unnoticed, fade back in anyway.
   */
  private updateWinFade(state: RoomStateView) {
    const fading = state.carWinner !== '' && state.carRoundTick >= state.carWinTick + WIN_TEXT_TICKS
    if (fading && !this.winFadingOut) this.cameras.main.fadeOut(WIN_FADE_OUT_MS, 0, 0, 0)
    else if (!fading && this.winFadingOut && state.carWinner === '') this.cameras.main.fadeIn(FADE_IN_MS, 0, 0, 0)
    this.winFadingOut = fading
  }

  /** The countdown (5, 4, 3, 2, 1, GO!), the winner, and whether we're out of the round. */
  private updateRoundHud(roundTick: number) {
    const left = COUNTDOWN_TICKS - roundTick
    const countdown = left > 0 ? String(Math.ceil(left / TICK_RATE)) : left > -TICK_RATE ? 'GO!' : ''
    if (this.countdownText.text !== countdown) this.countdownText.setText(countdown)

    const state = this.state
    const hasWinner = !!state?.carWinner
    const win = hasWinner && !this.winFadingOut ? `${state.carWinnerName} has won!!` : ''
    if (this.winText.text !== win) this.winText.setText(win)

    const mine = state?.cars.get(this.room.sessionId)
    const out = !hasWinner && mine && this.isOut(this.room.sessionId, mine)
      ? 'Eliminated! Spectating until everyone is out' : ''
    if (this.eliminatedText.text !== out) this.eliminatedText.setText(out)
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

  /** Obstacles, like the cars: from the predicted world once predicting (gone once it drops them). */
  private positionObstacles(state: RoomStateView, pose: WorldPose | undefined) {
    for (const [id, sprite] of this.obstacleSprites) {
      const obstacle = state.obstacles.get(id)
      const visible = !!obstacle && (!this.sim || this.carWorld.obstacles.has(id))
      sprite.setVisible(visible)
      if (!visible) continue
      if (pose) {
        const f = obstacleFields(obstacle.slot)
        sprite.setPosition(pose[f.x], pose[f.y]).setRotation(pose[f.angle])
      } else {
        sprite.setPosition(this.predict.value(obstacle, 'x'), this.predict.value(obstacle, 'y'))
          .setRotation(this.predict.value(obstacle, 'angle'))
      }
    }
  }

  /** `blinkOff`: our car is in the off phase of its countdown blink. */
  private positionCars(state: RoomStateView, pose: WorldPose | undefined, blinkOff: boolean) {
    for (const [id, sprite] of this.cars) {
      const car = state.cars.get(id)
      if (!car) continue
      // Eliminated cars have fallen into the void
      const visible = !this.isOut(id, car)
      sprite.setVisible(visible)
      if (!visible) continue

      let x: number, y: number, angle: number
      if (pose) {
        const f = seatFields(car.seat)
        x = pose[f.x]; y = pose[f.y]; angle = pose[f.angle]
      } else {
        x = this.predict.value(car, 'x')
        y = this.predict.value(car, 'y')
        angle = this.predict.value(car, 'angle')
      }
      sprite.setPosition(x, y).setRotation(angle)
        .setAlpha(blinkOff && id === this.room.sessionId ? OWN_BLINK_ALPHA : 1)
    }
  }

  /**
   * The same view for every player: north-up, fixed zoom, centered on the road
   * `CAMERA_AHEAD_OF_FRONT` ahead of the destruction front (at the predicted time the front is
   * drawn at, so it moves smoothly; through corners it follows the road). A new round's road
   * starts it back at the beginning. A car whose center leaves it is eliminated (`camera.ts`).
   */
  private updateCamera(frontS: number) {
    const point = cameraCenter(this.carWorld.road, frontS, this.cameraPoint)
    this.cameras.main.centerOn(point.x, point.y)
  }

  protected onDroppedChanged(dropped: boolean) {
    this.statusText.setText(dropped ? 'Connection lost, reconnecting…' : '')
  }

  protected disposeGame() {
    this.sim?.dispose()
    this.sim = undefined
    this.predict?.dispose()
    this.predict = undefined
    this.cpuDrivers?.dispose()
    this.cpuDrivers = undefined
    if (this.carWorld) destroyCarWorld(this.carWorld)
    this.carWorld = undefined
  }
}
