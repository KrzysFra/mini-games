import { Predict, type InputHandle, type SimReconciler } from '@colyseus/sdk'
import { Cameras, GameObjects, Geom, Input, Math as PMath, Types } from 'phaser'
import { INPUT_BUTTONS, TICK_RATE } from '../../../shared/constants'
import { CAR_LENGTH, CAR_WIDTH, ROAD_WIDTH } from '../../../shared/games/car-roquelike/constants'
import {
  CHUNK_SIZE, COUNTDOWN_TICKS, chunkBreakS, chunkHash, chunkIndex, destructionFrontS,
} from '../../../shared/games/car-roquelike/destruction'
import { MAP_BLOCKS } from '../../../shared/games/car-roquelike/map'
import { getRoad, isOnRoad, pointOnPiece, roadPointAt, roadTail, type Road, type RoadPiece } from '../../../shared/games/car-roquelike/road'
import {
  addCar, createCarWorld, destroyCarWorld, maintainRoad, removeCar, stepCarRound, toCarInput, writeCar,
  type CarInput, type CarSnapshot, type CarWorld, type GameInputLike,
} from '../../../shared/games/car-roquelike/physics'
import { textStyle } from '../../core/ui'
import { MiniGameScene } from '../MiniGameScene'

/** The fields of the server's room state this scene reads. */
interface CarView extends CarSnapshot {
  seat: number
  eliminated: boolean
}

interface PlayerView {
  name: string
}

interface RoomStateView {
  phase: string
  players: Map<string, PlayerView>
  cars: Map<string, CarView>
  carRound: number
  carRoundTick: number
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

/** Our car's pose plus the round tick, so the front is drawn smoothly at our predicted time. */
type CarPose = { x: number, y: number, angle: number, roundTick: number }

/** A road piece being drawn: its Graphics, bounds for culling, and where along the road it's drawn from. */
interface DrawnPiece {
  piece: RoadPiece
  graphics: GameObjects.Graphics
  bounds: Geom.Rectangle
  drawnFrom: number
}

interface CarSprite {
  container: GameObjects.Container
  name: GameObjects.Text
}

const CAR_COLORS = [0xd94f4f, 0x4f8fd9, 0x4fd97a, 0xe0c068, 0xb05fd9, 0x4fd9d0, 0xe08a3c, 0xe8e8e8]
const COLOR_OWN_OUTLINE = 0xffffff
const COLOR_BLOCK = 0x5b6169
const COLOR_DIRT = 0x6b4f33
const COLOR_ROAD = 0x3a3d42
const COLOR_ROAD_EDGE = 0xe8e8e8
const COLOR_ROAD_CENTER = 0xe0c068
/** Size of the repeating dirt texture. */
const DIRT_TILE = 256
const DIRT_TEXTURE = 'car-roquelike-dirt'
/** Dashed center line: one dash of DASH_LENGTH every DASH_SPACING. */
const DASH_LENGTH = 100
const DASH_SPACING = 200
/** Corners are drawn as polygons with a point every this many units along the road. */
const ROAD_DRAW_STEP = 40
/** The piece being deleted is redrawn (cut at the deletion line) whenever the line moved this far. */
const ROAD_REDRAW_STEP = 20

/** The void the world collapses into. */
const COLOR_VOID = 0x0a0807
const COLOR_CRACK = 0x14100c
/**
 * The crumbling edge is a pure function of the front's position: a chunk shows cracks for the last
 * CRACK_LEAD units of front travel before it breaks, then falls (shrinks, spins, darkens) over the
 * next FALL_DISTANCE units. At 90% top speed the front covers ~750 units/s.
 */
const CRACK_LEAD = 300
const FALL_DISTANCE = 300
/** How far a falling chunk spins by the time it's gone, at most (radians). */
const FALL_SPIN = 1.2
/** Teleports beyond this (a round restart) are cut instead of smoothed. */
const SNAP_DISTANCE = 500
/** The camera (the same for everyone) is on the road this far ahead of the destruction front. */
const CAMERA_AHEAD_OF_FRONT = 1000
/**
 * Fixed zoom. At 0.45 the view reaches 1200 above its center, so the spawn grid (1000..1100 up
 * the road from the camera during the countdown) is on screen at the start.
 */
const CAMERA_ZOOM = 0.45

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

/** Blend two 0xRRGGBB colors (t = 0 → a, 1 → b). */
const mixColor = (a: number, b: number, t: number) => {
  const channel = (shift: number) => {
    const ca = (a >> shift) & 0xff
    return Math.round(ca + (((b >> shift) & 0xff) - ca) * t) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

/**
 * car-roquelike: every player drives a car top-down along a randomly generated road (`road.ts`,
 * a new one each round, from `roadSeed`) surrounded by endless dirt (which halves top speed); cars
 * collide with each other. After a countdown the world collapses into the void from the road's
 * start, moving along the road at 95% of top speed (`destruction.ts`); a car caught by it is
 * eliminated, and once everyone is, the round restarts.
 *
 * The road is one Graphics per piece, culled to the view. The void and its ragged edge are drawn
 * chunk by chunk each frame (flat void, cracking and falling chunks), all derived from the front.
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
  private eliminatedScratch: string[] = []
  /** Our car's last pose while it existed, for the pose once it's gone (eliminated). */
  private lastPose: CarPose = { x: 0, y: 0, angle: 0, roundTick: 0 }

  private cars = new Map<string, CarSprite>()
  /** Covers the camera's view every frame, so the dirt looks endless. */
  private dirt: GameObjects.TileSprite
  /** The road being drawn (this round's), its pieces' Graphics and their bounds for culling. */
  private drawnRoad: Road | undefined
  private roadLayer: GameObjects.Layer
  private roadPieces: DrawnPiece[] = []
  /** Index in `road.pieces` of the next piece to draw once it's committed. */
  private nextRoadPiece = 0
  /** The void and its crumbling edge: fallen, falling and cracked chunks, redrawn every frame. */
  private crumble: GameObjects.Graphics
  /** Scratch corners of a falling chunk. */
  private corners = [new PMath.Vector2(), new PMath.Vector2(), new PMath.Vector2(), new PMath.Vector2()]
  private countdownText: GameObjects.Text
  private eliminatedText: GameObjects.Text
  /** Scratch point for the camera's spot on the road. */
  private cameraPoint = { x: 0, y: 0, heading: 0, s: 0 }
  private worldLayer: GameObjects.Layer
  private uiLayer: GameObjects.Layer
  private uiCamera: Cameras.Scene2D.Camera
  private statusText: GameObjects.Text
  /** HUD line: whether a gamepad is detected (and which), to debug controller setups in-game. */
  private padText: GameObjects.Text
  private keys: Record<'up' | 'down' | 'left' | 'right' | 'w' | 'a' | 's' | 'd' | 'space', Input.Keyboard.Key>

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
    this.drawnRoad = undefined
    this.roadPieces = []
    this.carWorld = createCarWorld()

    // World (zoomed, scrolling) and HUD (fixed) live on separate cameras
    this.worldLayer = this.add.layer()
    this.uiLayer = this.add.layer()
    this.drawWorld()

    this.statusText = this.add.text(this.scale.width / 2, 40, '', textStyle(32, '#d9776c')).setOrigin(0.5)
    const help = this.add.text(this.scale.width / 2, this.scale.height - 40,
      'Point where to drive: left stick or WASD / arrows (let go to brake)  ·  A / Space handbrake  ·  Start / Escape to stop',
      textStyle(26, '#9fb3bb')).setOrigin(0.5)
    this.padText = this.add.text(24, 20, '', textStyle(22, '#9fb3bb'))
    this.countdownText = this.add.text(this.scale.width / 2, this.scale.height / 2 - 160, '',
      { ...textStyle(160, '#ffffff'), stroke: '#000000', strokeThickness: 12 }).setOrigin(0.5)
    this.eliminatedText = this.add.text(this.scale.width / 2, 110, '',
      { ...textStyle(40, '#d9776c'), stroke: '#000000', strokeThickness: 6 }).setOrigin(0.5)
    this.uiLayer.add([this.statusText, help, this.padText, this.countdownText, this.eliminatedText])

    const camera = this.cameras.main
    camera.setBackgroundColor(COLOR_DIRT).ignore(this.uiLayer)
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
    this.predict.attachAll('cars', { fields: ['x', 'y'], mode: 'lerp', delay: 100, snap: SNAP_DISTANCE })
    this.predict.attachAll('cars', { fields: ['angle'], mode: 'lerp', delay: 100, angle: true })
    // Same handle for the room's whole life (the SDK caches it). Reliable: WebSocket has no
    // unreliable channel, so 'unreliable' would only add redundant copies (and a console warning)
    this.gameInput = this.room.input<GameInputLike>({ mode: 'reliable' })
  }

  private drawWorld() {
    if (!this.textures.exists(DIRT_TEXTURE)) this.createDirtTexture()
    this.dirt = this.add.tileSprite(0, 0, DIRT_TILE, DIRT_TILE, DIRT_TEXTURE).setOrigin(0)
    this.worldLayer.add(this.dirt)

    // The road's pieces go here (redrawn per round, `drawRoad`), above the dirt
    this.roadLayer = this.add.layer()
    this.worldLayer.add(this.roadLayer)

    // Above the ground, below the cars
    this.crumble = this.add.graphics()
    this.worldLayer.add(this.crumble)

    for (const block of MAP_BLOCKS) {
      this.worldLayer.add(this.add.rectangle(block.x, block.y, block.width, block.height, COLOR_BLOCK)
        .setStrokeStyle(4, 0x15171a))
    }
  }

  /**
   * Keep the drawn road in step with the road in play: one Graphics per committed piece, added as
   * the road grows and destroyed once the piece is deleted behind the front. The piece the
   * deletion line is in is redrawn from that line (only when it has moved a bit). A new round's
   * road replaces everything.
   */
  private syncRoad(road: Road, frontS: number) {
    if (road !== this.drawnRoad) {
      for (const drawn of this.roadPieces) drawn.graphics.destroy()
      this.roadPieces = []
      this.nextRoadPiece = 0
      this.drawnRoad = road
    }
    const tail = roadTail(frontS)

    // Deleted pieces go; the one the tail is in is cut there
    while (this.roadPieces.length > 0) {
      const first = this.roadPieces[0]
      if (first.piece.startS + first.piece.length > tail) break
      first.graphics.destroy()
      this.roadPieces.shift()
    }
    const first = this.roadPieces[0]
    if (first && first.drawnFrom < tail - ROAD_REDRAW_STEP) this.drawPiece(first, tail)
    else if (first && first.drawnFrom > tail) this.drawPiece(first, Math.max(first.piece.startS, tail))

    // Newly committed pieces
    for (; this.nextRoadPiece < road.committedPieces; this.nextRoadPiece++) {
      const piece = road.pieces[this.nextRoadPiece]
      if (piece.startS + piece.length <= tail) continue
      const drawn = { piece, graphics: this.add.graphics(), bounds: new Geom.Rectangle(), drawnFrom: 0 }
      this.roadLayer.add(drawn.graphics)
      this.drawPiece(drawn, Math.max(piece.startS, tail))
      this.roadPieces.push(drawn)
    }
  }

  /** (Re)draw a piece from `fromS` (along the road) to its end: asphalt, edge lines, dashes. */
  private drawPiece(drawn: DrawnPiece, fromS: number) {
    const { piece } = drawn
    const g = drawn.graphics.clear()
    drawn.drawnFrom = fromS
    const startU = fromS - piece.startS
    const half = ROAD_WIDTH / 2
    const point = { x: 0, y: 0, heading: 0, s: 0 }
    /** Points along the piece, offset sideways by `offset` (+ = right of the direction of travel). */
    const edge = (offset: number) => {
      const steps = Math.max(1, Math.ceil((piece.length - startU) / ROAD_DRAW_STEP))
      const points: PMath.Vector2[] = []
      for (let k = 0; k <= steps; k++) {
        pointOnPiece(piece, startU + ((piece.length - startU) * k) / steps, point)
        points.push(new PMath.Vector2(
          point.x - Math.sin(point.heading) * offset,
          point.y + Math.cos(point.heading) * offset,
        ))
      }
      return points
    }

    const left = edge(-half)
    const right = edge(half)
    g.fillStyle(COLOR_ROAD).fillPoints([...left, ...right.slice().reverse()], true)
    g.lineStyle(8, COLOR_ROAD_EDGE)
      .strokePoints(edge(-half + 12), false)
      .strokePoints(edge(half - 12), false)

    // Dashes continue across pieces: one every DASH_SPACING of the whole road
    g.fillStyle(COLOR_ROAD_CENTER)
    const along = DASH_LENGTH / 2
    const firstDash = Math.ceil((fromS + along) / DASH_SPACING) * DASH_SPACING
    for (let s = firstDash; s < piece.startS + piece.length; s += DASH_SPACING) {
      pointOnPiece(piece, s - piece.startS, point)
      const cos = Math.cos(point.heading)
      const sin = Math.sin(point.heading)
      g.fillPoints([
        new PMath.Vector2(point.x - cos * along + sin * 4, point.y - sin * along - cos * 4),
        new PMath.Vector2(point.x + cos * along + sin * 4, point.y + sin * along - cos * 4),
        new PMath.Vector2(point.x + cos * along - sin * 4, point.y + sin * along + cos * 4),
        new PMath.Vector2(point.x - cos * along - sin * 4, point.y - sin * along + cos * 4),
      ], true)
    }

    // Bounds, for culling: the edge points cover the whole piece
    const xs = [...left, ...right].map(p => p.x)
    const ys = [...left, ...right].map(p => p.y)
    drawn.bounds.setTo(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  }

  /** Only render the road pieces the camera can see (Graphics are re-tessellated every frame). */
  private cullRoad() {
    const view = this.cameras.main.worldView
    for (const piece of this.roadPieces) {
      piece.graphics.setVisible(Geom.Rectangle.Overlaps(view, piece.bounds))
    }
  }

  /** A tileable dirt texture: brown with speckles from a fixed pattern (same look every time). */
  private createDirtTexture() {
    const g = this.make.graphics({}, false)
    g.fillStyle(COLOR_DIRT).fillRect(0, 0, DIRT_TILE, DIRT_TILE)
    const speckles = [0x5a4129, 0x7d6042, 0x4e3823, 0x86694a]
    let seed = 12345
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let i = 0; i < 260; i++) {
      const size = 3 + next() * 7
      g.fillStyle(speckles[i % speckles.length])
        .fillRect(Math.floor(next() * (DIRT_TILE - size)), Math.floor(next() * (DIRT_TILE - size)), size, size)
    }
    g.generateTexture(DIRT_TEXTURE, DIRT_TILE, DIRT_TILE)
    g.destroy()
  }

  /** Stretch the dirt over the camera's view (plus a margin); its pattern stays fixed to the world. */
  private updateDirt() {
    const view = this.cameras.main.worldView
    const margin = DIRT_TILE
    const x = Math.floor((view.x - margin) / DIRT_TILE) * DIRT_TILE
    const y = Math.floor((view.y - margin) / DIRT_TILE) * DIRT_TILE
    this.dirt.setPosition(x, y).setSize(view.width + margin * 3, view.height + margin * 3)
    this.dirt.setTilePosition(x, y)
  }

  /**
   * Draw the destruction with the front at `frontS` (distance along the road) over the camera's
   * view, chunk by chunk. Fully fallen chunks are the flat void, merged into one rectangle per run
   * along a row; around the edge, chunks crack and then fall away (see `CRACK_LEAD` /
   * `FALL_DISTANCE`), on top of the void.
   */
  private updateDestruction(road: Road, frontS: number) {
    const view = this.cameras.main.worldView
    const g = this.crumble.clear()
    const firstRow = chunkIndex(view.y) - 1
    const lastRow = chunkIndex(view.bottom) + 1
    const firstCol = chunkIndex(view.x) - 1
    const lastCol = chunkIndex(view.right) + 1

    g.fillStyle(COLOR_VOID)
    for (let j = firstRow; j <= lastRow; j++) {
      const y = j * CHUNK_SIZE
      let runStart: number | undefined
      for (let i = firstCol; i <= lastCol + 1; i++) {
        // How far past this chunk's break point the front is (negative: not broken yet)
        const t = i <= lastCol ? frontS - chunkBreakS(road, i, j, frontS) : -Infinity
        if (t >= 0) {
          runStart ??= i
          continue
        }
        if (runStart !== undefined) {
          g.fillRect(runStart * CHUNK_SIZE, y, (i - runStart) * CHUNK_SIZE, CHUNK_SIZE)
          runStart = undefined
        }
      }
    }

    // The edge, over the void: cracking chunks, and broken ones still falling
    for (let j = firstRow; j <= lastRow; j++) {
      for (let i = firstCol; i <= lastCol; i++) {
        const t = frontS - chunkBreakS(road, i, j, frontS)
        if (t < -CRACK_LEAD || t >= FALL_DISTANCE) continue
        const x = i * CHUNK_SIZE
        const y = j * CHUNK_SIZE
        if (t < 0) this.drawCracks(g, i, j, x, y, 1 + t / CRACK_LEAD)
        else this.drawFallingChunk(g, road, frontS, i, j, x, y, t / FALL_DISTANCE)
      }
    }
  }

  /** Cracks spreading from near the chunk's center to three of its edges, fading in (`alpha`). */
  private drawCracks(g: GameObjects.Graphics, i: number, j: number, x: number, y: number, alpha: number) {
    const s = CHUNK_SIZE
    const cx = x + s * (0.3 + 0.4 * chunkHash(i, j, 4))
    const cy = y + s * (0.3 + 0.4 * chunkHash(i, j, 5))
    g.lineStyle(2, COLOR_CRACK, alpha)
    g.lineBetween(cx, cy, x + s * chunkHash(i, j, 6), y)
    g.lineBetween(cx, cy, x + s, y + s * chunkHash(i, j, 7))
    g.lineBetween(cx, cy, x + s * chunkHash(i, j, 8), y + s)
  }

  /** A broken-off chunk dropping into the void: shrinks, spins and darkens as `progress` goes 0 → 1. */
  private drawFallingChunk(
    g: GameObjects.Graphics, road: Road, frontS: number, i: number, j: number, x: number, y: number, progress: number,
  ) {
    const cx = x + CHUNK_SIZE / 2
    const cy = y + CHUNK_SIZE / 2
    const ground = isOnRoad(road, cx, cy, frontS) ? COLOR_ROAD : COLOR_DIRT
    const half = (CHUNK_SIZE / 2) * (1 - progress)
    const angle = (chunkHash(i, j, 3) - 0.5) * FALL_SPIN * progress
    const cos = Math.cos(angle) * half
    const sin = Math.sin(angle) * half
    const c = this.corners
    c[0].x = cx - cos + sin; c[0].y = cy - sin - cos
    c[1].x = cx + cos + sin; c[1].y = cy + sin - cos
    c[2].x = cx + cos - sin; c[2].y = cy + sin + cos
    c[3].x = cx - cos - sin; c[3].y = cy - sin + cos
    g.fillStyle(mixColor(ground, COLOR_VOID, progress)).fillPoints(c, true)
  }

  /** Start predicting our own car once the server has given us one. */
  private startPrediction() {
    const me = this.room.sessionId
    this.sim = this.predict.sim<GameInputLike, CarPose, PredictedWorld>({
      input: this.gameInput,
      world: { physics: this.carWorld, roundTick: this.state?.carRoundTick ?? 0 },
      // Exactly what the server does for one tick (countdown, physics, elimination); other cars
      // just coast until the next update. The round tick is predicted along with the inputs.
      step: (ctx, world, command) => {
        this.stepInputs.set(me, toCarInput(command, this.stepInputs.get(me)))
        stepCarRound(world.physics, this.stepInputs, world.roundTick, ctx.subSteps, ctx.subDtMs, this.eliminatedScratch)
        world.roundTick++
      },
      // Server truth for every car and the round tick, then the predictor replays our
      // unconfirmed inputs on top
      adopt: world => {
        this.adoptServerCars(world.physics) // (the road too: a new one comes with each round)
        world.roundTick = this.state?.carRoundTick ?? 0
      },
      pose: world => {
        const body = world.physics.cars.get(me)
        const pose = this.lastPose
        if (body) {
          pose.x = body.position.x
          pose.y = body.position.y
          pose.angle = body.angle
        }
        return { x: pose.x, y: pose.y, angle: pose.angle, roundTick: world.roundTick }
      },
      smoothMs: 65,
      // A round restart moves everything back to the start: cut, don't glide
      snap: SNAP_DISTANCE,
    })
  }

  /** Make the local physics world match the server's cars exactly (eliminated cars are gone). */
  private adoptServerCars(physics: CarWorld) {
    const serverCars = this.state?.cars
    if (!serverCars) return
    if (physics.road.seed !== this.state.roadSeed) physics.road = getRoad(this.state.roadSeed)
    for (const id of [...physics.cars.keys()]) {
      if (!serverCars.get(id) || serverCars.get(id).eliminated) removeCar(physics, id)
    }
    for (const [id, car] of serverCars) {
      if (car.eliminated) continue
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

  /** The round tick to draw at: predicted along with our car once we have one, else the server's. */
  private renderRoundTick(): number {
    return this.sim ? this.sim.pose().roundTick : (this.state?.carRoundTick ?? 0)
  }

  /**
   * Whether a car is out of the round: the server says so, or (our own car) the prediction
   * already dropped it into the void.
   */
  private isOut(id: string, car: CarView): boolean {
    if (car.eliminated) return true
    return id === this.room.sessionId && !!this.sim && !this.carWorld.cars.has(id)
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

    const roundTick = this.renderRoundTick()
    const frontS = destructionFrontS(roundTick)
    if (this.state) {
      // This round's road, generated ahead of the leading car (the predicted world has every car)
      if (this.carWorld.road.seed !== this.state.roadSeed) this.carWorld.road = getRoad(this.state.roadSeed)
      maintainRoad(this.carWorld, frontS)
      this.syncRoad(this.carWorld.road, frontS)
    }
    this.positionCars()
    this.updateCamera(frontS)
    this.updateDirt()
    this.cullRoad()
    if (this.drawnRoad) this.updateDestruction(this.drawnRoad, frontS)
    this.updateRoundHud(roundTick)
    this.updatePadStatus()
  }

  /** The countdown (5, 4, 3, 2, 1, GO!) and whether we're out of the round. */
  private updateRoundHud(roundTick: number) {
    const left = COUNTDOWN_TICKS - roundTick
    const countdown = left > 0 ? String(Math.ceil(left / TICK_RATE)) : left > -TICK_RATE ? 'GO!' : ''
    if (this.countdownText.text !== countdown) this.countdownText.setText(countdown)

    const mine = this.state?.cars.get(this.room.sessionId)
    const out = mine && this.isOut(this.room.sessionId, mine)
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
      const car = state.cars.get(id)
      if (!car) continue
      // Eliminated cars have fallen into the void
      const visible = !this.isOut(id, car)
      sprite.container.setVisible(visible)
      sprite.name.setVisible(visible)
      if (!visible) continue

      let x: number, y: number, angle: number
      if (id === me && this.sim) {
        const pose = this.sim.pose()
        x = pose.x; y = pose.y; angle = pose.angle
      } else {
        x = this.predict.value(car, 'x')
        y = this.predict.value(car, 'y')
        angle = this.predict.value(car, 'angle')
      }
      sprite.container.setPosition(x, y).setRotation(angle)
      sprite.name.setPosition(x, y - CAR_LENGTH * 0.75)
    }
  }

  /**
   * The same view for every player: north-up, fixed zoom, centered on the road
   * `CAMERA_AHEAD_OF_FRONT` ahead of the destruction front (at the predicted time the front is
   * drawn at, so it moves smoothly; through corners it follows the road). A new round's road
   * starts it back at the beginning.
   */
  private updateCamera(frontS: number) {
    if (!this.state) return
    const point = roadPointAt(this.carWorld.road, frontS + CAMERA_AHEAD_OF_FRONT, this.cameraPoint)
    this.cameras.main.setZoom(CAMERA_ZOOM).centerOn(point.x, point.y)
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
