import { KIND_LIST, OBSTACLE_CHANCE, OBSTACLE_KINDS, OBSTACLE_SEGMENT, type ObstacleKind } from '@shared/games/car-roquelike/obstacles'
import {
  MAX_WEIGHT, MAX_WEIGHT_DISTANCE, MAX_WEIGHT_ROWS, parseCarSettings, sanitizeCarSettings, type CarRoquelikeSettings,
} from '@shared/games/car-roquelike/settings'
import type { SettingsEditor } from '../settings'
import { createHtmlButton, htmlInputStyle } from '@core/ui'

type Row = CarRoquelikeSettings['obstacleWeights'][number]

/** Distance a new row starts after the last one. */
const NEW_ROW_DISTANCE = 25000

interface RowView {
  tr: HTMLTableRowElement
  startsAt: HTMLTableCellElement
  distance: HTMLInputElement
  weights: Record<ObstacleKind, HTMLInputElement>
}

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

/**
 * car-roquelike's settings: the obstacle weights table (`OBSTACLE_WEIGHTS`), one row per step:
 * its distance (from the previous row's start) and each kind's weight. Rows can be added and
 * deleted. Every change sends the whole table; the room state's copy is what's shown.
 */
export function createCarSettingsEditor(send: (settings: object | null) => void): SettingsEditor {
  const element = document.createElement('div')

  const help = document.createElement('div')
  help.textContent = 'Obstacle spawn weights along the road. Each row applies from its start until the next one ' +
    '(the last for good). Distance: from the previous row\'s start (the first: from the road\'s start; ' +
    `the camera covers about 50000 a minute). Weight 1 = a ${Math.round(OBSTACLE_CHANCE * 100)}% chance per ` +
    `${OBSTACLE_SEGMENT} of road; a kind's share of spawns is its share of the row's total.`
  Object.assign(help.style, { font: '22px Arial', color: '#9fb3bb', marginBottom: '16px', lineHeight: '1.35' })
  element.appendChild(help)

  const table = document.createElement('table')
  Object.assign(table.style, { borderCollapse: 'collapse', font: '24px Arial', color: '#ffffff' })
  const head = table.createTHead().insertRow()
  const headCell = (content: string | HTMLElement) => {
    const th = document.createElement('th')
    Object.assign(th.style, { padding: '6px 10px', textAlign: 'left', fontWeight: 'normal', color: '#9fb3bb' })
    th.append(content)
    head.appendChild(th)
  }
  headCell('#')
  headCell('Starts at')
  headCell('Distance')
  for (const kind of KIND_LIST) {
    const label = document.createElement('span')
    const swatch = document.createElement('span')
    Object.assign(swatch.style, {
      display: 'inline-block', width: '22px', height: '22px', marginRight: '8px', verticalAlign: '-3px',
      background: hex(OBSTACLE_KINDS[kind].color), border: '2px solid #000000',
    })
    label.append(swatch, kind)
    headCell(label)
  }
  headCell('')
  const body = table.createTBody()
  element.appendChild(table)

  const footer = document.createElement('div')
  Object.assign(footer.style, { display: 'flex', gap: '16px', marginTop: '20px' })
  const addButton = createHtmlButton('+ Add row', () => {
    const rows = [...shown.obstacleWeights]
    const last = rows[rows.length - 1]
    rows.push(last ? [NEW_ROW_DISTANCE, { ...last[1] }] : [0, { brown: 1 }])
    commit(rows)
  })
  const resetButton = createHtmlButton('Reset to defaults', () => send(null))
  footer.append(addButton, resetButton)
  element.appendChild(footer)

  const views: RowView[] = []
  /** The settings on display (the room's, or our last change until the room echoes it). */
  let shown = parseCarSettings(undefined)

  /** The table as typed in. */
  const readRows = (): Row[] => views.map(view => {
    const weights: Partial<Record<ObstacleKind, number>> = {}
    for (const kind of KIND_LIST) weights[kind] = Number(view.weights[kind].value)
    return [Number(view.distance.value), weights] as const
  })

  /** Show a changed table right away (as the server will sanitize it) and send it. */
  const commit = (rows: Row[]) => {
    const settings = sanitizeCarSettings({ obstacleWeights: rows })
    if (!settings) return
    render(settings, true)
    send(settings)
  }

  const numberInput = (max: number, step: number) => {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '0'
    input.max = String(max)
    input.step = String(step)
    Object.assign(input.style, htmlInputStyle, { width: '150px' })
    input.addEventListener('change', () => commit(readRows()))
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
    return input
  }

  const createRow = (): RowView => {
    const tr = body.insertRow()
    const cell = (content?: HTMLElement) => {
      const td = tr.insertCell()
      td.style.padding = '6px 10px'
      if (content) td.appendChild(content)
      return td
    }
    const index = cell()
    index.style.color = '#9fb3bb'
    const startsAt = cell()
    startsAt.style.color = '#9fb3bb'
    const distance = numberInput(MAX_WEIGHT_DISTANCE, 1000)
    cell(distance)
    const weights = {} as Record<ObstacleKind, HTMLInputElement>
    for (const kind of KIND_LIST) {
      weights[kind] = numberInput(MAX_WEIGHT, 0.1)
      weights[kind].style.width = '120px'
      cell(weights[kind])
    }
    const view: RowView = { tr, startsAt, distance, weights }
    const remove = createHtmlButton('✕', () => {
      const rows = readRows()
      rows.splice(views.indexOf(view), 1)
      commit(rows)
    })
    remove.title = 'Delete row'
    remove.style.background = '#a84a42'
    cell(remove)
    return view
  }

  /** Bring the table in line with `settings`; inputs being typed in are left alone, unless `force`. */
  const render = (settings: CarRoquelikeSettings, force = false) => {
    shown = settings
    const rows = settings.obstacleWeights
    while (views.length < rows.length) views.push(createRow())
    while (views.length > rows.length) views.pop().tr.remove()

    let startsAt = 0
    rows.forEach(([distance, weights], i) => {
      const view = views[i]
      startsAt += distance
      view.tr.cells[0].textContent = String(i + 1)
      view.startsAt.textContent = String(startsAt)
      const set = (input: HTMLInputElement, value: number) => {
        if (force || document.activeElement !== input) input.value = String(value)
      }
      set(view.distance, distance)
      for (const kind of KIND_LIST) set(view.weights[kind], weights[kind] ?? 0)
    })
    addButton.disabled = rows.length >= MAX_WEIGHT_ROWS
    addButton.style.opacity = addButton.disabled ? '0.5' : '1'
  }

  return { element, update: json => render(parseCarSettings(json)) }
}
