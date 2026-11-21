import { AUTO, Game, Scale, Types } from 'phaser'
import { configCursorKeys } from './game/scenes/examples/cursor-keys'
import { configMatterConstraits } from './game/scenes/examples/matter-constraints'

let currentGameIndex = 1
let currentGame: Game = undefined

const games = [
  configMatterConstraits,
  configCursorKeys,
]

const startGame = (config: Types.Core.GameConfig) => {
  currentGame?.destroy(true)

  currentGame = new Game({
    ...config,
    parent: 'game-container',
    width: 1920,
    height: 1080,
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