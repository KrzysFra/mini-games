import { GameObjects, Geom, Math as PMath, type Scene } from 'phaser'
import { ROAD_WIDTH } from '@shared/games/car-roquelike/constants'
import { piecesInPlay, pointOnPiece, roadTail, type Road, type RoadPiece } from '@shared/games/car-roquelike/road'

export const COLOR_DIRT = 0x6b4f33
export const COLOR_ROAD = 0x3a3d42
const COLOR_ROAD_EDGE = 0xe8e8e8
const COLOR_ROAD_CENTER = 0xe0c068
/** Size of the repeating dirt texture. */
const DIRT_TILE = 256
const DIRT_TEXTURE = 'car-roquelike-dirt'
/** Edge lines: this thick, this far in from the road's edge. */
const EDGE_LINE_WIDTH = 8
const EDGE_LINE_INSET = 12
/** Dashed center line: one dash of DASH_LENGTH × DASH_WIDTH every DASH_SPACING. */
const DASH_LENGTH = 100
const DASH_WIDTH = 8
const DASH_SPACING = 200
/** Corners are drawn as polygons with a point every this many units along the road. */
const ROAD_DRAW_STEP = 40
/** The piece being deleted is redrawn (cut at the deletion line) whenever the line moved this far. */
const ROAD_REDRAW_STEP = 20

/** A road piece being drawn: its Graphics, bounds for culling, and where along the road it's drawn from. */
interface DrawnPiece {
  piece: RoadPiece
  graphics: GameObjects.Graphics
  bounds: Geom.Rectangle
  drawnFrom: number
}

/** Scratch (never kept): a point on the road, and a dash's corners. */
const roadPoint = { x: 0, y: 0, heading: 0, s: 0 }
const dash = [new PMath.Vector2(), new PMath.Vector2(), new PMath.Vector2(), new PMath.Vector2()]

/**
 * The ground: endless dirt (a TileSprite re-fitted to the camera's view each frame) and the road,
 * one Graphics per piece in play, added as it comes into play (off screen), destroyed once it's deleted
 * behind the front, and culled to the view (Graphics are re-tessellated every frame they render).
 */
export class RoadView {
  private dirt: GameObjects.TileSprite
  private layer: GameObjects.Layer
  /** The road being drawn (this round's). */
  private road: Road | undefined
  private pieces: DrawnPiece[] = []
  /** Index in `road.pieces` of the next piece to draw once it's in play. */
  private nextPiece = 0

  constructor(private scene: Scene, parent: GameObjects.Layer) {
    if (!scene.textures.exists(DIRT_TEXTURE)) this.createDirtTexture()
    this.dirt = scene.add.tileSprite(0, 0, DIRT_TILE, DIRT_TILE, DIRT_TEXTURE).setOrigin(0)
    this.layer = scene.add.layer()
    parent.add([this.dirt, this.layer])
  }

  /**
   * Keep the drawn road in step with the road in play: pieces coming into play are drawn, deleted
   * ones go, and the piece the deletion line is in is redrawn from that line (only when it has
   * moved a bit). A new round's road replaces everything.
   */
  sync(road: Road, frontS: number) {
    if (road !== this.road) {
      for (const drawn of this.pieces) drawn.graphics.destroy()
      this.pieces = []
      this.nextPiece = 0
      this.road = road
    }
    const tail = roadTail(road, frontS)

    // Deleted pieces go; the one the tail is in is cut there
    let deleted = 0
    while (deleted < this.pieces.length && pieceEnd(this.pieces[deleted].piece) <= tail) {
      this.pieces[deleted++].graphics.destroy()
    }
    if (deleted > 0) this.pieces.splice(0, deleted)
    const first = this.pieces[0]
    if (first && (first.drawnFrom < tail - ROAD_REDRAW_STEP || first.drawnFrom > tail)) {
      this.drawPiece(first, Math.max(first.piece.startS, tail))
    }

    // Pieces come into play
    for (const inPlay = piecesInPlay(road, frontS); this.nextPiece < inPlay; this.nextPiece++) {
      const piece = road.pieces[this.nextPiece]
      if (pieceEnd(piece) <= tail) continue
      const drawn = { piece, graphics: this.scene.add.graphics(), bounds: new Geom.Rectangle(), drawnFrom: 0 }
      this.layer.add(drawn.graphics)
      this.drawPiece(drawn, Math.max(piece.startS, tail))
      this.pieces.push(drawn)
    }
  }

  /** Fit the dirt to the camera's view and only render the road pieces in it. */
  updateView(view: Geom.Rectangle) {
    // The dirt covers the view plus a margin; its pattern stays fixed to the world
    const x = Math.floor((view.x - DIRT_TILE) / DIRT_TILE) * DIRT_TILE
    const y = Math.floor((view.y - DIRT_TILE) / DIRT_TILE) * DIRT_TILE
    this.dirt.setPosition(x, y).setSize(view.width + DIRT_TILE * 3, view.height + DIRT_TILE * 3)
    this.dirt.setTilePosition(x, y)

    for (const drawn of this.pieces) drawn.graphics.setVisible(Geom.Rectangle.Overlaps(view, drawn.bounds))
  }

  /** (Re)draw a piece from `fromS` (along the road) to its end: asphalt, edge lines, dashes. */
  private drawPiece(drawn: DrawnPiece, fromS: number) {
    const { piece } = drawn
    const g = drawn.graphics.clear()
    drawn.drawnFrom = fromS
    const startU = fromS - piece.startS
    const half = ROAD_WIDTH / 2
    const steps = Math.max(1, Math.ceil((piece.length - startU) / ROAD_DRAW_STEP))

    /** Points along the piece, offset sideways by `offset` (+ = right of the direction of travel). */
    const edge = (offset: number) => {
      const points: PMath.Vector2[] = []
      for (let k = 0; k <= steps; k++) {
        pointOnPiece(piece, startU + ((piece.length - startU) * k) / steps, roadPoint)
        points.push(new PMath.Vector2(
          roadPoint.x - Math.sin(roadPoint.heading) * offset,
          roadPoint.y + Math.cos(roadPoint.heading) * offset,
        ))
      }
      return points
    }

    const left = edge(-half)
    const right = edge(half)
    g.fillStyle(COLOR_ROAD).fillPoints(left.concat(right.slice().reverse()), true)
    g.lineStyle(EDGE_LINE_WIDTH, COLOR_ROAD_EDGE)
      .strokePoints(edge(-half + EDGE_LINE_INSET), false)
      .strokePoints(edge(half - EDGE_LINE_INSET), false)

    // Dashes continue across pieces: one every DASH_SPACING of the whole road
    g.fillStyle(COLOR_ROAD_CENTER)
    const along = DASH_LENGTH / 2
    const across = DASH_WIDTH / 2
    const firstDash = Math.ceil((fromS + along) / DASH_SPACING) * DASH_SPACING
    for (let s = firstDash; s < pieceEnd(piece); s += DASH_SPACING) {
      pointOnPiece(piece, s - piece.startS, roadPoint)
      const { x, y } = roadPoint
      const cos = Math.cos(roadPoint.heading)
      const sin = Math.sin(roadPoint.heading)
      dash[0].set(x - cos * along + sin * across, y - sin * along - cos * across)
      dash[1].set(x + cos * along + sin * across, y + sin * along - cos * across)
      dash[2].set(x + cos * along - sin * across, y + sin * along + cos * across)
      dash[3].set(x - cos * along - sin * across, y - sin * along + cos * across)
      g.fillPoints(dash, true)
    }

    // Bounds, for culling: the edge points cover the whole piece
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of left.concat(right)) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    drawn.bounds.setTo(minX, minY, maxX - minX, maxY - minY)
  }

  /** A tileable dirt texture: brown with speckles from a fixed pattern (same look every time). */
  private createDirtTexture() {
    const g = this.scene.make.graphics({}, false)
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
}

const pieceEnd = (piece: RoadPiece) => piece.startS + piece.length
