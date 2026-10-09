#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-boot-menu-background-launch-row')
for (const k of ['MERCURY_CONCOURSE_WORKER', 'MERCURY_ENTER_MENU', 'MERCURY_BOOT_ENV_APPLIED', 'MERCURY_SESSION_SUBAGENTS', 'MERCURY_SESSION_WORKFLOWS']) delete process.env[k]

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const boot = await import('../../src/components/BootSettingsScreen.js')
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.js')
const setting = await import('../../src/services/switchboard/backgroundLaunch.js')

const COLS = 178
const ROWS = 51
const LABEL = setting.BACKGROUND_LAUNCH_LABEL
const KEY_NAME = setting.BACKGROUND_LAUNCH_KEY
const FILE = join(HOME, '.mercury.json')
const stored = (): unknown => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>)[KEY_NAME] : undefined)
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const has = (lines: string[], needle: string): boolean => lines.some(line => line.includes(needle))
function paneLines(lines: string[], title: string, width: number): string[] {
  const header = lines.find(line => line.includes(title))
  if (header === undefined) return []
  const left = header.indexOf(title) - 2
  return lines.map(line => Array.from(line).slice(left + 1, left + width - 1).join('').trim())
}
const paneText = (lines: string[], title: string, width: number): string => collapse(paneLines(lines, title, width).join(' '))
const DETAIL_PANE = 'SETTING DETAIL'
const DETAIL_PANE_WIDTH = 46
const rowOf = (lines: string[]): string => lines.find(line => new RegExp(`❯ ${LABEL}\\s+(?:on|off)\\s`).test(line)) ?? ''

async function openBootFace(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(boot.BootSettingsScreen as never, { fullScene: { columns: COLS, rows: ROWS }, onClose: () => {} })),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  await waitFor(() => m.screen().includes('CONTROL PLANE'), 4000)
  await settle(250)
  return m
}
async function press(m: Mounted, data: string, ms = 120): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function selectMarked(m: Mounted, mark: string, max = 60): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    if (has(m.lines(), mark)) return true
    await press(m, KEY.down, 70)
  }
  return has(m.lines(), mark)
}

console.log('§1 the row joins the AGENTS group of the table: after Workflows, before JEV, counted by the one composer')
{
  const rows = boot.withJevRow(STARTUP_MENU)
  const at = rows.findIndex(row => row.env === KEY_NAME)
  check('the composer carries the row', at > 0, String(at))
  check('it follows the Workflows row and precedes JEV, all three under agents', rows[at - 1]?.env === 'MERCURY_SESSION_WORKFLOWS' && rows[at + 1]?.env === 'jev' && rows[at]?.group === 'agents', rows.map(row => row.env).join(' '))
  check('the table grew by the two config-backed agents rows and nothing else', rows.length === STARTUP_MENU.length + 2, String(rows.length))
  check('the row is a live toggle, off by default, keyed by the leaf', rows[at]?.kind === 'toggle' && rows[at]?.defaultLabel === 'off' && rows[at]?.applicationClass === 'live' && rows[at]?.options.length === 1 && rows[at]?.options[0] === 'on')
  check('every detail line fits the SETTING DETAIL text width, on and off', [true, false].every(on => boot.backgroundLaunchBootDetailLines(on).every(line => stringWidth(line) <= boot.JEV_BOOT_DETAIL_WIDTH)), boot.backgroundLaunchBootDetailLines(false).join(' | '))
}

console.log('§2 the Boot Settings face: the row selected, its detail pane, ↵ flips the one leaf, ⌫ returns to off')
{
  check('a fresh home stores nothing for the leaf', stored() === undefined && setting.backgroundSessionsLaunchCrewmates() === false)
  const m = await openBootFace()
  const found = await selectMarked(m, `❯ ${LABEL}`)
  check('↓ reaches the row', found, m.lines().filter(line => line.includes(LABEL)).join(' | '))
  const lines = m.lines()
  const row = rowOf(lines)
  const rowAt = lines.indexOf(row)
  check('the row sits under AGENTS after Workflows and before JEV', rowAt > 0 && (lines[rowAt - 1] ?? '').includes('Workflows') && (lines[rowAt + 1] ?? '').includes('JEV'), `${lines[rowAt - 1] ?? ''} / ${row} / ${lines[rowAt + 1] ?? ''}`)
  check("the row's value column reads off", new RegExp(`❯ ${LABEL}\\s+off\\s`).test(row), row)
  const pane = paneText(lines, DETAIL_PANE, DETAIL_PANE_WIDTH)
  check('the detail pane names what it controls in the operator\'s words', pane.includes('What it controls') && pane.includes('Whether a session left in the background may launch crewmates and workflows when its brief says so, as a focused one does.'), pane)
  check('the pane carries the current value and the detail lines (now: off (default), the doors)', pane.includes('Current value off') && pane.includes('now: off (default)') && pane.includes('doors: /config · Boot Menu (one switch)'), pane)
  check('the pane lists the on and off effects, whole', pane.includes('When on') && pane.includes('launches crewmates and workflows without your visit') && pane.includes('its own switches still rule first') && pane.includes('When off') && pane.includes('waits for your visit or the workflows-allowed tag') && pane.includes('the launch refusal names this row'), pane)
  check('no detail line is clipped with an ellipsis', !paneLines(lines, DETAIL_PANE, DETAIL_PANE_WIDTH).some(line => line.endsWith('…')), paneLines(lines, DETAIL_PANE, DETAIL_PANE_WIDTH).filter(line => line.endsWith('…')).join(' | '))
  await press(m, KEY.enter, 300)
  check('↵ turns it on through the one writer: the file carries the leaf true', stored() === true && setting.backgroundSessionsLaunchCrewmates() === true, String(stored()))
  const after = m.lines()
  check('the value column now reads on', new RegExp(`❯ ${LABEL}\\s+on\\s`).test(rowOf(after)), rowOf(after))
  check("the status bar carries the owner's receipt", has(after, `${LABEL} on — backgrounded sessions launch as a focused one does`), after.filter(line => line.includes('System ready')).join(' | '))
  check('the pane now reads now: on', paneText(after, DETAIL_PANE, DETAIL_PANE_WIDTH).includes('now: on'))
  check('boot-env.json never carries the switch (the row is config-backed)', !existsSync(join(HOME, 'boot-env.json')) || !readFileSync(join(HOME, 'boot-env.json'), 'utf8').includes(KEY_NAME))
  await press(m, KEY.enter, 300)
  check('a second ↵ turns it off and the key leaves the file', stored() === undefined && setting.backgroundSessionsLaunchCrewmates() === false && has(m.lines(), `${LABEL} off — backgrounded sessions wait for a visit or the tag`), m.lines().filter(line => line.includes('System ready')).join(' | '))
  await press(m, KEY.right, 300)
  check('→ turns it on again', stored() === true)
  await press(m, '\x7f', 300)
  check('⌫ returns the row to its default: off, the key gone', stored() === undefined && new RegExp(`❯ ${LABEL}\\s+off\\s`).test(rowOf(m.lines())), rowOf(m.lines()))
  m.unmount()
  await settle(60)
}

console.log('§3 the two doors are one switch: the boot face reads what /config wrote')
{
  setting.setBackgroundSessionsLaunchCrewmates(true)
  const m = await openBootFace()
  await selectMarked(m, `❯ ${LABEL}`)
  check('the row reads on, written by the other door', new RegExp(`❯ ${LABEL}\\s+on\\s`).test(rowOf(m.lines())), rowOf(m.lines()))
  m.unmount()
  await settle(60)
  setting.setBackgroundSessionsLaunchCrewmates(false)
}

releaseScratchHome(HOME)
console.log(failures === 0 ? '\nprove-boot-menu-background-launch-row: ALL LAWS HOLD' : `\nprove-boot-menu-background-launch-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
