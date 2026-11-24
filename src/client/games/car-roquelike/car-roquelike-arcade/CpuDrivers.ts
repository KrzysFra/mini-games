import type { InputHandle, Room } from '@colyseus/sdk'
import { MAX_PLAYERS_PER_ROOM, SANDBOX_CPU_PLAYERS, TICK_RATE } from '@shared/constants'
import { destructionFrontS } from '@shared/games/car-roquelike/destruction'
import { getRoad, roadDistanceAt, roadPointAt } from '@shared/games/car-roquelike/road'
import type { GameInputLike } from '@shared/games/car-roquelike/physics'
import { client } from '@core/network'

/** The fields of the room state a CPU driver reads (from its own connection's copy). */
interface CpuCarView {
  x: number
  y: number
  vx: number
  vy: number
  eliminated: boolean
}

interface CpuStateView {
  players: Map<string, { cpu: boolean }>
  cars: Map<string, CpuCarView>
  carRoundTick: number
  roadSeed: number
}

/** How a CPU drives: which side of the road it keeps to, and how much it goes for nearby cars. */
interface Personality {
  /** Sideways offset from the centerline (to the right of the road's direction). */
  lane: number
  /** 0 = just races; up to 1 = steers straight at a car close ahead. */
  aggression: number
}

const PERSONALITIES: Personality[] = [
  { lane: -80, aggression: 0.15 },
  { lane: 80, aggression: 0.7 },
]

/** Aims at the road this far ahead, plus more the faster it goes. */
const LOOKAHEAD_BASE = 220
const LOOKAHEAD_PER_SPEED = 18
/** Slow weave around its lane, so it doesn't drive a perfect line. */
const WEAVE_AMPLITUDE = 60
const WEAVE_RATE = 0.04
/** Cars ahead within this distance get rammed (by `aggression`). */
const RAM_RANGE = 350
/** How often a tab checks whether the room is short of CPU drivers. */
const TOP_UP_INTERVAL_MS = 1000
const STEP_MS = 1000 / TICK_RATE
/** Same cap as the SDK's `Predict.MAX_STEPS_PER_FRAME` idea: after a hitch, drop the backlog. */
const MAX_STEPS_PER_FRAME = 4

const roadPoint = { x: 0, y: 0, heading: 0, s: 0 }

/** One CPU driver: its own connection to the room, sending one input per tick like a player. */
class CpuDriver {
  readonly input: InputHandle<GameInputLike>

  constructor(readonly room: Room, private personality: Personality, private weavePhase: number) {
    this.input = room.input<GameInputLike>({ mode: 'reliable' })
  }

  /**
   * Stage the input from what this connection last received of the room (so it reacts with the same
   * delay a player's view has): follow the road, and swerve at a car close ahead if aggressive.
   */
  stage() {
    const data = this.input.data
    data.x = 0
    data.y = 0
    data.buttons = 0

    const state = this.room.state as CpuStateView | undefined
    const car = state?.cars?.get(this.room.sessionId)
    if (!car || car.eliminated) return

    const road = getRoad(state.roadSeed)
    const frontS = destructionFrontS(state.carRoundTick)
    const s = roadDistanceAt(road, car.x, car.y, frontS)
    const speed = Math.hypot(car.vx, car.vy)
    const p = roadPointAt(road, s + LOOKAHEAD_BASE + speed * LOOKAHEAD_PER_SPEED, roadPoint)

    // (-sin, cos) is the right-hand side of the heading (+y is down)
    const lane = this.personality.lane + Math.sin(state.carRoundTick * WEAVE_RATE + this.weavePhase) * WEAVE_AMPLITUDE
    let dx = p.x - Math.sin(p.heading) * lane - car.x
    let dy = p.y + Math.cos(p.heading) * lane - car.y
    let length = Math.hypot(dx, dy) || 1
    dx /= length
    dy /= length

    const target = this.ramTarget(state, car, dx, dy)
    if (target) {
      const a = this.personality.aggression
      let tx = target.x - car.x
      let ty = target.y - car.y
      const tl = Math.hypot(tx, ty) || 1
      dx = dx * (1 - a) + (tx / tl) * a
      dy = dy * (1 - a) + (ty / tl) * a
      length = Math.hypot(dx, dy) || 1
      dx /= length
      dy /= length
    }

    data.x = dx
    data.y = dy
  }

  /** The nearest other car within `RAM_RANGE` roughly in the direction we're heading. */
  private ramTarget(state: CpuStateView, car: CpuCarView, dirX: number, dirY: number): CpuCarView | undefined {
    if (this.personality.aggression <= 0) return undefined
    let best: CpuCarView | undefined
    let bestDist = RAM_RANGE
    for (const [id, other] of state.cars) {
      if (id === this.room.sessionId || other.eliminated) continue
      const ox = other.x - car.x
      const oy = other.y - car.y
      const dist = Math.hypot(ox, oy)
      // Ahead: within ~60° of where we're going
      if (dist < bestDist && ox * dirX + oy * dirY > dist * 0.5) {
        best = other
        bestDist = dist
      }
    }
    return best
  }
}

/**
 * Sandbox only: keeps `SANDBOX_CPU_PLAYERS` CPU drivers in the room. Each is a real extra
 * connection from this tab (shared `client`, `joinById` with `{ cpu: true }`), sending inputs
 * through `room.input()` at the tick rate, paced by this tab's frames like the player's own; so
 * the network (and any latency simulation on the SDK) treats them like players. The server caps
 * CPUs, so with several tabs open whichever asks first hosts them, and another tab takes over
 * when that one goes away.
 */
export class CpuDrivers {
  private drivers: CpuDriver[] = []
  private joining = false
  private disposed = false
  private nextTopUp = 0
  private lastTime = -1
  private stepAcc = 0

  constructor(private hostRoom: Room) {}

  /** Call once per frame with the frame time. */
  update(time: number) {
    if (this.disposed) return
    if (time >= this.nextTopUp) {
      this.nextTopUp = time + TOP_UP_INTERVAL_MS
      this.topUp()
    }

    const dt = this.lastTime < 0 ? 0 : time - this.lastTime
    this.lastTime = time
    this.stepAcc += dt
    let steps = Math.floor(this.stepAcc / STEP_MS)
    this.stepAcc -= steps * STEP_MS
    if (steps > MAX_STEPS_PER_FRAME) {
      steps = MAX_STEPS_PER_FRAME
      this.stepAcc = 0
    }
    if (steps === 0) return

    for (const driver of this.drivers) {
      driver.stage()
      for (let i = 0; i < steps; i++) driver.input.send()
    }
  }

  dispose() {
    this.disposed = true
    for (const driver of this.drivers) driver.room.leave().catch(() => { /* already gone */ })
    this.drivers = []
  }

  /** Join one more CPU driver if the room (as the player's connection sees it) is short of them. */
  private topUp() {
    const players = (this.hostRoom.state as CpuStateView | undefined)?.players
    if (this.joining || !players) return
    let cpus = 0
    for (const player of players.values()) if (player.cpu) cpus++
    if (cpus >= SANDBOX_CPU_PLAYERS || players.size >= MAX_PLAYERS_PER_ROOM) return

    this.joining = true
    client.joinById(this.hostRoom.roomId, { cpu: true })
      .then(room => {
        if (this.disposed) {
          room.leave().catch(() => { /* already gone */ })
          return
        }
        const index = this.drivers.length
        const driver = new CpuDriver(room, PERSONALITIES[index % PERSONALITIES.length], index * 2.1)
        this.drivers.push(driver)
        room.onLeave(() => { this.drivers = this.drivers.filter(d => d !== driver) })
      })
      // Another tab got there first, or the room is full: try again later
      .catch(e => console.info('[car-roquelike] CPU driver not joined:', e?.message ?? e))
      .finally(() => { this.joining = false })
  }
}
