#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/ink.js'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-popup-short-host')
const frameDir = ((): string | undefined => {
  const index = process.argv.indexOf('--frames')
  return index < 0 ? undefined : process.argv[index + 1]
})()
if (frameDir) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const slot = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

type Scene = { columns: number; rows: number; bottom: number }
const SCENES: Scene[] = [
  { columns: 82, rows: 17, bottom: 4 },
  { columns: 80, rows: 14, bottom: 2 },
  { columns: 80, rows: 21, bottom: 4 },
]
const ROW = 'Sub-agent default model'
const TITLE = 'Mercury · config'
const HINT_TAIL = CONFIG_POPUP_HINT.slice(-26)

function scaffold(scene: Scene, centreRef: React.RefObject<DOMElement | null>): React.ReactNode {
  const body = scene.rows - scene.bottom
  return React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(
      ThemeProvider as never,
      {},
      React.createElement(
        Box,
        { flexDirection: 'column', width: scene.columns, height: scene.rows },
        React.createElement(
          Box,
          { ref: centreRef, flexDirection: 'column', height: body, flexShrink: 0, overflow: 'hidden' },
          ...Array.from({ length: body }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, index === 0 ? 'CENTRE' : 'c'.repeat(scene.columns))),
        ),
        React.createElement(Box, { height: scene.bottom, flexShrink: 0, flexDirection: 'column' }, ...Array.from({ length: scene.bottom }, (_, index) => React.createElement(Text, { key: index }, 'B'.repeat(scene.columns)))),
        React.createElement(slot.SettingsPopupSlot, { overlay: true, hostRef: centreRef, framed: false }),
      ),
    ),
  )
}

type Frame = { top: number; bottom: number; left: number; right: number; rows: string[] }

function frameOf(lines: string[]): Frame | null {
  const top = lines.findIndex(line => /^\s*╭─+╮\s*$/.test(line))
  if (top < 0) return null
  const left = lines[top]!.indexOf('╭')
  const right = lines[top]!.indexOf('╮', left)
  const bottom = lines.findIndex((line, y) => y > top && line[left] === '╰')
  if (bottom < 0) return null
  return { top, bottom, left, right, rows: lines.slice(top, bottom + 1).map(line => line.slice(left, right + 1)) }
}

async function holdsStill(m: Mounted, polls: number, ms: number): Promise<boolean> {
  let last = m.screen()
  let run = 0
  return waitFor(() => {
    const now = m.screen()
    run = now === last ? run + 1 : 0
    last = now
    return run >= polls
  }, ms)
}

const context = { messages: [], options: {} } as never
const label = (scene: Scene): string => `${scene.columns}×${scene.rows}, a ${scene.rows - scene.bottom}-row view`

for (const scene of SCENES) {
  console.log(`\n§ ${label(scene)}: /config filtered to one row with a three-line description keeps its title and its hint row`)
  const centreRef = React.createRef<DOMElement>()
  const m = await mountOffscreen(scaffold(scene, centreRef), scene.columns, scene.rows)
  const up = (await waitFor(() => m.screen().includes('CENTRE') && m.screen().includes('BBBB'), 4000)) && (await holdsStill(m, 2, 2000))
  check(`${label(scene)}: the scaffold painted and held still`, up)
  const request = configPopupRequest(context)
  store.openSettingsPopup(request)
  const opened = (await waitFor(() => m.screen().includes(TITLE) && m.screen().includes(HINT_TAIL), 4000)) && (await holdsStill(m, 2, 2000))
  check(`${label(scene)}: the popup opened whole at rest, its title and its hint row on screen`, opened, m.lines().filter(line => line.trim() !== '').slice(0, 4).join(' | '))
  const geometry = slot.settingsPopupGeometry(request, scene.columns, scene.rows, 0, { top: 0, rows: scene.rows - scene.bottom })
  m.push(ROW)
  await settle(120)
  m.push(KEY.enter)
  const rowUp = (await waitFor(() => m.screen().includes(`› ${ROW}`), 4000)) && (await holdsStill(m, 3, 2500))
  const lines = m.lines()
  if (frameDir) writeFileSync(join(frameDir, `config-${ROW.toLowerCase().replace(/ /g, '-')}-${scene.columns}x${scene.rows}.txt`), lines.join('\n') + '\n')
  const frame = frameOf(lines)
  check(`${label(scene)}: the filtered row is selected${geometry.rowBudget >= 4 ? ' and its description shows' : ' (a body of ' + geometry.rowBudget + ' rows has no room for its description)'}`, rowUp && (geometry.rowBudget < 4 || lines.some(line => line.includes('the model a spawned agent runs on'))), lines.filter(line => line.includes(ROW)).join(' | '))
  check(`${label(scene)}: the frame stands whole, ${geometry.rows} rows tall as the host allows, both border cells on every row`, frame !== null && geometry.rows !== null && frame.bottom - frame.top + 1 === geometry.rows && frame.rows.slice(1, -1).every(row => row.startsWith('│') && row.endsWith('│')), frame === null ? 'no frame' : `${frame.bottom - frame.top + 1} rows at ${frame.top}..${frame.bottom}`)
  check(`${label(scene)}: the title row is the first row inside the frame`, frame !== null && (frame.rows[1] ?? '').includes(TITLE), frame === null ? 'no frame' : JSON.stringify(frame.rows[1]))
  check(`${label(scene)}: the hint row is the last row inside the frame, whole to its esc words`, frame !== null && (frame.rows.at(-2) ?? '').includes(HINT_TAIL), frame === null ? 'no frame' : JSON.stringify(frame.rows.at(-2)))
  check(`${label(scene)}: the body is cut inside the frame, never squeezing the chrome (the selected row stays, the description may lose its tail)`, frame !== null && frame.rows.some(row => row.includes(`› ${ROW}`)) && !lines.some((line, y) => frame !== null && (y < frame.top || y > frame.bottom) && line.includes('Inherit follows')), frame === null ? 'no frame' : frame.rows.join('\n'))
  check(`${label(scene)}: the bottom rows under the view are untouched`, lines.slice(scene.rows - scene.bottom).every(line => line === 'B'.repeat(scene.columns)), lines.slice(scene.rows - scene.bottom).join(' | '))
  store.closeSettingsPopup()
  await waitFor(() => !m.screen().includes(TITLE), 2000)
  m.unmount()
  await settle(40)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-config-popup-short-host: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
