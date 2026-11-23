import { AUTO, Game, Scale, Types } from 'phaser'
import { configCursorKeys } from './game/scenes/examples/cursor-keys'
import { configMatterConstraits } from './game/scenes/examples/matter-constraints'
import { configPillMove } from './game/scenes/tests/pill-move/scene'

let currentGameIndex = 0
let currentGame: Game = undefined

const games = [
  configPillMove,
  configCursorKeys,
  configMatterConstraits,
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