#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-still' }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'
import { menuRowChoices, STARTUP_MENU, type MenuRow } from '../../src/substrate/startupMenu.js'
import { SEATS_MENU_ROW } from '../../src/services/switchboard/capacityCheck.js'
import { __motionGovernorResetForTest, setMotionPosture } from '../../src/utils/cockpit/motionGovernor.js'
import { MOTION_MENU_ROW, motionDetailLines, motionValueWords } from '../../src/utils/cockpit/motionSetting.js'

export const STILLS_DIR = join(import.meta.dir, 'fixtures', 'motion-menu')

const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })

export function menuRows(): readonly MenuRow[] {
  return [...STARTUP_MENU, SEATS_MENU_ROW as MenuRow, MOTION_MENU_ROW as MenuRow]
}

export function composeMotionMenu(cols: number, rows: number, setting: 'auto' | 'full' | 'reduced' | 'off' = 'auto'): string[] {
  delete process.env.MERCURY_CRITTER_IDLE
  delete process.env.MERCURY_LIVE_GLYPHS
  __motionGovernorResetForTest()
  setMotionPosture(setting)
  const list = menuRows()
  const entries = list.map(row => {
    if (row.env === SEATS_MENU_ROW.env) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: "6 · this machine's reading",
        valueIsDefault: true,
        pinnedVal: null,
        detail: row.detail ?? null,
        detailExtra: ['reading: 6 seats (this machine)', '8 cores · 12.0 GB available', '384 MB a seat (a session runner)', 'doors: /seats N · Boot Menu · /config', '/seats auto returns to the reading'],
      }
    }
    if (row.env === MOTION_MENU_ROW.env) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: motionValueWords(setting),
        valueIsDefault: setting === 'auto',
        pinnedVal: null,
        detail: row.detail ?? null,
        detailExtra: motionDetailLines(),
      }
    }
    return {
      label: row.label,
      group: row.group,
      summary: row.summary,
      valueLabel: menuRowChoices(row)[0]!.label,
      valueIsDefault: true,
      pinnedVal: null,
      detail: row.detail ?? null,
      detailExtra: ['this session  default (default)'],
    }
  })
  const m = {
    entries,
    selIdx: entries.length - 1,
    summary: { profile: 'r0 · default', harness: 'helm · console', integrity: 'enforce', integritySet: false },
    environment: { model: 'Opus 5', critter: 'Octopus', critterHue: '#B07BE0', dirBase: 'orchard-src', dirTail: '' },
    statusRight: 'changes reach new sessions',
    legend: '↑↓ move · ↵ change (saved) · ⌫ default · a apply receipts · esc back',
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

export const STILLS: ReadonlyArray<{ id: string; compose: () => string[] }> = [
  { id: 'menu-120x40', compose: () => composeMotionMenu(120, 40) },
  { id: 'menu-100x34', compose: () => composeMotionMenu(100, 34) },
  { id: 'menu-120x40-reduced', compose: () => composeMotionMenu(120, 40, 'reduced') },
]

export function stillPath(id: string): string {
  return join(STILLS_DIR, `${id}.txt`)
}

export function readStill(id: string): string | null {
  try {
    return readFileSync(stillPath(id), 'utf8')
  } catch {
    return null
  }
}

export function renderStill(lines: string[]): string {
  return lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n'
}

if (import.meta.main && process.argv.includes('--write')) {
  mkdirSync(STILLS_DIR, { recursive: true })
  for (const still of STILLS) {
    writeFileSync(stillPath(still.id), renderStill(still.compose()))
    console.log(`wrote ${stillPath(still.id)}`)
  }
}
