import { GameObjects, Geom, Math as PMath, type Scene } from 'phaser'
import { CHUNK_SIZE, chunkBreakS, chunkHash, chunkIndex } from '@shared/games/car-roquelike/destruction'
import { isOnRoad, type Road } from '@shared/games/car-roquelike/road'
import { COLOR_DIRT, COLOR_ROAD } from './RoadView'

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

/** Blend two 0xRRGGBB colors (t = 0 → a, 1 → b). */
const mixColor = (a: number, b: number, t: number) => {
  const channel = (shift: number) => {
    const ca = (a >> shift) & 0xff
    return Math.round(ca + (((b >> shift) & 0xff) - ca) * t) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

/**
 * The destruction, redrawn every frame over the camera's view from the front's position alone:
 * fully fallen chunks are the flat void, merged into one rectangle per run along a row; around the
 * edge, chunks crack and then fall away (see `CRACK_LEAD` / `FALL_DISTANCE`), on top of the void.
 */
export class DestructionView {
  private graphics: GameObjects.Graphics
  /** Edge chunks found while drawing the void, drawn after it: (i, j, t) triples, reused. */
  private edge: number[] = []
  /** Scratch corners of a falling chunk. */
  private corners = [new PMath.Vector2(), new PMath.Vector2(), new PMath.Vector2(), new PMath.Vector2()]

  constructor(scene: Scene, parent: GameObjects.Layer) {
    this.graphics = scene.add.graphics()
    parent.add(this.graphics)
  }

  /** Draw with the front at `frontS` (distance along the road). */
  update(road: Road, frontS: number, view: Geom.Rectangle) {
    const g = this.graphics.clear()
    const firstRow = chunkIndex(view.y) - 1
    const lastRow = chunkIndex(view.bottom) + 1
    const firstCol = chunkIndex(view.x) - 1
    const lastCol = chunkIndex(view.right) + 1
    const edge = this.edge
    edge.length = 0

    // One pass over the chunks: the void as runs per row, the edge chunks noted for later
    g.fillStyle(COLOR_VOID)
    for (let j = firstRow; j <= lastRow; j++) {
      let runStart: number | undefined
      for (let i = firstCol; i <= lastCol + 1; i++) {
        // How far past this chunk's break point the front is (negative: not broken yet)
        const t = i <= lastCol ? frontS - chunkBreakS(road, i, j, frontS) : -Infinity
        if (t >= -CRACK_LEAD && t < FALL_DISTANCE) edge.push(i, j, t)
        if (t >= 0) {
          runStart ??= i
        } else if (runStart !== undefined) {
          g.fillRect(runStart * CHUNK_SIZE, j * CHUNK_SIZE, (i - runStart) * CHUNK_SIZE, CHUNK_SIZE)
          runStart = undefined
        }
      }
    }

    // The edge, over the void: cracking chunks, and broken ones still falling
    for (let k = 0; k < edge.length; k += 3) {
      const i = edge[k], j = edge[k + 1], t = edge[k + 2]
      if (t < 0) this.drawCracks(i, j, 1 + t / CRACK_LEAD)
      else this.drawFallingChunk(road, frontS, i, j, t / FALL_DISTANCE)
    }
  }

  /** Cracks spreading from near the chunk's center to three of its edges, fading in (`alpha`). */
  private drawCracks(i: number, j: number, alpha: number) {
    const s = CHUNK_SIZE
    const x = i * s
    const y = j * s
    const cx = x + s * (0.3 + 0.4 * chunkHash(i, j, 4))
    const cy = y + s * (0.3 + 0.4 * chunkHash(i, j, 5))
    this.graphics.lineStyle(2, COLOR_CRACK, alpha)
      .lineBetween(cx, cy, x + s * chunkHash(i, j, 6), y)
      .lineBetween(cx, cy, x + s, y + s * chunkHash(i, j, 7))
      .lineBetween(cx, cy, x + s * chunkHash(i, j, 8), y + s)
  }

  /** A broken-off chunk dropping into the void: shrinks, spins and darkens as `progress` goes 0 → 1. */
  private drawFallingChunk(road: Road, frontS: number, i: number, j: number, progress: number) {
    const cx = (i + 0.5) * CHUNK_SIZE
    const cy = (j + 0.5) * CHUNK_SIZE
    const ground = isOnRoad(road, cx, cy, frontS) ? COLOR_ROAD : COLOR_DIRT
    const half = (CHUNK_SIZE / 2) * (1 - progress)
    const angle = (chunkHash(i, j, 3) - 0.5) * FALL_SPIN * progress
    const cos = Math.cos(angle) * half
    const sin = Math.sin(angle) * half
    const c = this.corners
    c[0].set(cx - cos + sin, cy - sin - cos)
    c[1].set(cx + cos + sin, cy + sin - cos)
    c[2].set(cx + cos - sin, cy + sin + cos)
    c[3].set(cx - cos - sin, cy - sin + cos)
    this.graphics.fillStyle(mixColor(ground, COLOR_VOID, progress)).fillPoints(c, true)
  }
}
