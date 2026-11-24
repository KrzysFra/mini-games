import { GameObjects, Scene, Types } from 'phaser'

/** Shared look and widgets for the menu-style scenes (Lobby, GameSelectionRoom). */

export const COLOR_BUTTON = 0x3a8f5c
export const COLOR_BUTTON_HOVER = 0x47ab6f
export const COLOR_BUTTON_DISABLED = 0x5a5f61

export const textStyle = (size: number, color = '#ffffff'): Types.GameObjects.Text.TextStyle => ({
  fontFamily: 'Arial', fontSize: size, color,
})

export const titleStyle: Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Arial Black', fontSize: 72, color: '#ffffff',
  stroke: '#000000', strokeThickness: 8,
}

/**
 * A button container; not added to the display list, so it can go into a scene or a container.
 * Toggle it later with `setButtonEnabled`, relabel it with `setButtonLabel`.
 */
export const createButton = (scene: Scene, x: number, y: number, w: number, h: number, label: string,
  onClick: () => void, enabled = true) => {
  const bg = new GameObjects.Rectangle(scene, 0, 0, w, h, COLOR_BUTTON).setStrokeStyle(3, 0x000000)
  const text = new GameObjects.Text(scene, 0, 0, label, textStyle(Math.round(h * 0.45))).setOrigin(0.5)
  const button = new GameObjects.Container(scene, x, y, [bg, text])
  const isEnabled = () => button.getData('enabled') === true

  bg.setInteractive()
  bg.on('pointerover', () => { if (isEnabled()) bg.setFillStyle(COLOR_BUTTON_HOVER) })
  bg.on('pointerout', () => { if (isEnabled()) bg.setFillStyle(COLOR_BUTTON); button.setScale(1) })
  bg.on('pointerdown', () => { if (isEnabled()) button.setScale(0.95) })
  bg.on('pointerup', () => {
    button.setScale(1)
    if (isEnabled()) onClick()
  })

  setButtonEnabled(button, enabled)
  return button
}

export const setButtonEnabled = (button: GameObjects.Container, enabled: boolean) => {
  const [bg, text] = button.list as [GameObjects.Rectangle, GameObjects.Text]
  button.setData('enabled', enabled).setScale(1)
  bg.setFillStyle(enabled ? COLOR_BUTTON : COLOR_BUTTON_DISABLED)
  bg.input.cursor = enabled ? 'pointer' : 'default'
  text.setAlpha(enabled ? 1 : 0.6)
}

export const setButtonLabel = (button: GameObjects.Container, label: string) => {
  (button.list[1] as GameObjects.Text).setText(label)
}

/** Look of HTML inputs placed over the game (sizes in game pixels: the DOM container is game-sized). */
export const htmlInputStyle: Partial<CSSStyleDeclaration> = {
  height: '48px',
  boxSizing: 'border-box',
  padding: '0 12px',
  font: '24px Arial',
  color: '#ffffff',
  background: '#262b2d',
  border: '3px solid #000000',
  outline: 'none',
}

/** An HTML button in the look of `createButton`, for HTML panels over the game. */
export const createHtmlButton = (label: string, onClick: () => void) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  Object.assign(button.style, {
    height: '48px',
    padding: '0 20px',
    font: '24px Arial',
    color: '#ffffff',
    background: '#' + COLOR_BUTTON.toString(16).padStart(6, '0'),
    border: '3px solid #000000',
    cursor: 'pointer',
  })
  button.addEventListener('click', () => { if (!button.disabled) onClick() })
  return button
}
