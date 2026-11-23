import { AUTO, Game, Scale, Types } from 'phaser'
import { configCursorKeys } from './sandbox/examples/cursor-keys'
import { configMatterConstraints } from './sandbox/examples/matter-constraints'
import { configPillMove } from './sandbox/pill-move/scene'

let currentGameIndex = 0
let currentGame: Game = undefined

const games = [
  configPillMove,
  configCursorKeys,
  configMatterConstraints,
]

export const screenWidth = 1920
export const screenHeight = 1080

const startGame = (config: Types.Core.GameConfig) => {
  currentGame?.destroy(true)

  currentGame = new Game({
    ...config,
    parent: 'game-container',
    width: screenWidth,
    height: screenHeight,
    scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH },
    type: AUTO,
    backgroundColor: '#30373a',
  })
}

document.addEventListener('DOMContentLoaded', () => {
  startGame(games[currentGameIndex])
})

document.addEventListener('keydown', e => {
  if (e.code == 'ArrowRight' && e.ctrlKey) {
    currentGameIndex++
    if (currentGameIndex >= games.length) currentGameIndex = 0

    startGame(games[currentGameIndex])
  }

  if (e.code == 'ArrowLeft' && e.ctrlKey) {
    currentGameIndex--
    if (currentGameIndex < 0) currentGameIndex = games.length - 1

    startGame(games[currentGameIndex])
  }
})