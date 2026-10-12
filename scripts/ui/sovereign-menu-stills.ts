#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-still' }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { createSplashCore } from '../../assets/splash/splash-core.mjs'
import { menuRowValueLabel, menuRowWarning, STARTUP_MENU, type MenuRow } from '../../src/substrate/startupMenu.js'
import { SEATS_MENU_ROW } from '../../src/services/switchboard/capacityCheck.js'
import { MOTION_MENU_ROW } from '../../src/utils/cockpit/motionSetting.js'

export const STILLS_DIR = join(import.meta.dir, 'fixtures', 'sovereign-menu')
export const SOVEREIGN_ROW_ENV = 'MERCURY_SKIP_PERMISSIONS'

export function menuRows(): readonly MenuRow[] {
  return [...STARTUP_MENU, SEATS_MENU_ROW as MenuRow, MOTION_MENU_ROW as MenuRow]
}

export interface SovereignMenuOptions {
  sovereign?: 'on' | 'off'
  color?: boolean
}

export function composeSovereignMenu(cols: number, rows: number, options: SovereignMenuOptions = {}): string[] {
  const sovereign = options.sovereign ?? 'on'
  const core = createSplashCore(options.color === true ? { nocolor: false, truecolor: true, accent: 'crimson' } : { nocolor: true, truecolor: false, accent: 'crimson' })
  const list = menuRows()
  const saved: Record<string, string> = sovereign === 'on' ? { [SOVEREIGN_ROW_ENV]: '1' } : {}
  const entries = list.map(row => {
    if (row.env === SEATS_MENU_ROW.env) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: "6 · this machine's reading",
        valueIsDefault: true,
        pinnedVal: null,
        warn: null,
        detail: row.detail ?? null,
        detailExtra: ['reading: 6 seats (this machine)', '8 cores · 12.0 GB available', '384 MB a seat (a session runner)', 'doors: /seats N · Boot Menu · /config', '/seats auto returns to the reading'],
      }
    }
    if (row.env === MOTION_MENU_ROW.env) {
      return {
        label: row.label,
        group: row.group,
        summary: row.summary,
        valueLabel: 'auto · follows the terminal',
        valueIsDefault: true,
        pinnedVal: null,
        warn: null,
        detail: row.detail ?? null,
        detailExtra: ['this session  default (default)'],
      }
    }
    const value = saved[row.env] ?? null
    return {
      label: row.label,
      group: row.group,
      summary: row.summary,
      valueLabel: menuRowValueLabel(row, value, env => saved[env] ?? null),
      valueIsDefault: value === null,
      pinnedVal: null,
      warn: menuRowWarning(row, value),
      detail: row.detail ?? null,
      detailExtra: [`this session  ${value ?? 'default'} (${value === null ? 'default' : 'profile'})`],
    }
  })
  const selIdx = list.findIndex(row => row.env === SOVEREIGN_ROW_ENV)
  const changed = Object.keys(saved).length
  const m = {
    entries,
    selIdx,
    summary: { profile: `r${changed} · ${changed > 0 ? `custom · ${changed} set` : 'default'}`, harness: 'helm · console' },
    environment: { model: 'Opus 5', critter: 'Octopus', critterHue: '#B07BE0', dirBase: 'orchard-src', dirTail: '' },
    statusRight: changed > 0 ? `${changed} choice saved — applies to new sessions` : 'changes reach new sessions',
    legend: '↑↓ move · ↵ change (saved) · ⌫ default · a apply receipts · esc back',
  }
  const menu = core.composeBootMenu(cols, rows, m) as { lines: string[] }
  const { placed } = core.placeBlock(menu.lines, rows) as { placed: string[] }
  return placed
}

export const STILLS: ReadonlyArray<{ id: string; compose: () => string[] }> = [
  { id: 'menu-120x40', compose: () => composeSovereignMenu(120, 40) },
  { id: 'menu-80x24', compose: () => composeSovereignMenu(80, 24) },
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

const ROW = {
  assets: 'scripts/ui/fixtures/sovereign-menu/*.txt',
  generator: 'bun scripts/ui/sovereign-menu-stills.ts --write',
  check: 'bun scripts/ui/prove-sovereign-menu-warning.ts',
  sources: 'scripts/ui/sovereign-menu-stills.ts assets/splash/splash-core.mjs src/substrate/startupMenu.ts src/services/switchboard/capacityCheck.ts src/utils/cockpit/motionSetting.ts',
}
if (import.meta.main && registerOnlyRequested(ROW)) process.exit(0)
if (import.meta.main && process.argv.includes('--write')) {
  mkdirSync(STILLS_DIR, { recursive: true })
  for (const still of STILLS) {
    writeFileSync(stillPath(still.id), renderStill(still.compose()))
    console.log(`wrote ${stillPath(still.id)}`)
  }
  registerGeneratedAsset(ROW)
}
