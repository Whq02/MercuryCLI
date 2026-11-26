#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-boot-menu-background-launch-row')
for (const k of ['MERCURY_CONCOURSE_WORKER', 'MERCURY_ENTER_MENU', 'MERCURY_BOOT_ENV_APPLIED', 'MERCURY_SESSION_SUBAGENTS']) delete process.env[k]

let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}

const React = await import('react')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { stringWidth } = await import('../../src/screen/renderer/stringWidth.js')
const boot = await import('../../src/screen/boot-face/BootSettingsScreen.js')
const { STARTUP_MENU } = await import('../../src/platform/substrate/startupMenu.js')
const setting = await import('../../src/daemon/switchboard/backgroundLaunch.js')

const COLS = 178
const ROWS = 51
const LABEL = setting.BACKGROUND_LAUNCH_LABEL
const KEY_NAME = setting.BACKGROUND_LAUNCH_KEY
const FILE = join(HOME, '.mercury.json')
const stored = (): unknown => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>)[KEY_NAME] : undefined)
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
const has = (lines: string[], needle: string): boolean => lines.some(line => line.includes(needle))
function paneLines(lines: string[]): string[] {
  const top = lines.findIndex(line => line.includes('╭') && line.includes('╮'))
  if (top < 0) return []
  const left = lines[top]!.indexOf('╭')
  const right = lines[top]!.indexOf('╮')
  const out: string[] = []
  for (let i = top; i < lines.length; i++) {
    const line = lines[i]!
    const ch = line[left]
    if (i > top && ch !== '│' && ch !== '╰' && line.slice(0, right + 1).trim() !== '') break
    out.push(line.slice(right + 1).trim())
  }
  return out
}
const paneText = (lines: string[]): string => collapse(paneLines(lines).join(' '))
const rowOf = (lines: string[]): string => lines.find(line => new RegExp(`❯ ${LABEL}\\s+(?:on|off)\\s`).test(line)) ?? ''

async function openBootFace(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(boot.BootSettingsScreen as never, { fullScene: { columns: COLS, rows: ROWS }, onClose: () => {} })),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  await waitFor(() => m.screen().includes('TRUST COMBO'), 4000)
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

console.log('§1 the row joins the AGENTS group of the table: after Crewmates, before JEV, counted by the one composer')
{
  const rows = boot.withJevRow(STARTUP_MENU)
  const at = rows.findIndex(row => row.env === KEY_NAME)
  check('the composer carries the row', at > 0, String(at), 'withJevRow in src/screen/boot-face/BootSettingsScreen.tsx must add BACKGROUND_LAUNCH_MENU_ROW from src/daemon/switchboard/backgroundLaunch.ts to the table')
  check('it follows the Crewmates row and precedes JEV, all three under agents', rows[at - 1]?.env === 'MERCURY_SESSION_SUBAGENTS' && rows[at - 1]?.group === 'agents' && rows[at + 1]?.env === 'jev' && rows[at]?.group === 'agents', rows.map(row => row.env).join(' '), 'withJevRow in src/screen/boot-face/BootSettingsScreen.tsx must place the row after the Crewmates row and before the JEV row, all in the agents group')
  check('the table grew by the two config-backed agents rows and nothing else', rows.length === STARTUP_MENU.length + 2, String(rows.length), 'withJevRow in src/screen/boot-face/BootSettingsScreen.tsx must add only the background launch row and the JEV row to STARTUP_MENU')
  check('the row is a live toggle, off by default, keyed by the leaf', rows[at]?.kind === 'toggle' && rows[at]?.defaultLabel === 'off' && rows[at]?.applicationClass === 'live' && rows[at]?.options.length === 1 && rows[at]?.options[0] === 'on', '', 'BACKGROUND_LAUNCH_MENU_ROW in src/daemon/switchboard/backgroundLaunch.ts must stay a live toggle with defaultLabel off and the single option on')
  check('every detail line fits the SETTING DETAIL text width, on and off', [true, false].every(on => boot.backgroundLaunchBootDetailLines(on).every(line => stringWidth(line) <= boot.JEV_BOOT_DETAIL_WIDTH)), boot.backgroundLaunchBootDetailLines(false).join(' | '), 'backgroundLaunchBootDetailLines in src/screen/boot-face/settings/detailLines.ts must wrap every line within JEV_BOOT_DETAIL_WIDTH')
}

console.log('§2 the Boot Settings face: the row selected, its detail pane, ↵ flips the one leaf, ⌫ returns to off')
{
  check('a fresh home stores nothing for the leaf', stored() === undefined && setting.backgroundSessionsLaunchCrewmates() === false, '', 'backgroundSessionsLaunchCrewmates in src/daemon/switchboard/backgroundLaunch.ts must read false with nothing stored; look for state left in the scratch home')
  const m = await openBootFace()
  const found = await selectMarked(m, `❯ ${LABEL}`)
  check('↓ reaches the row', found, m.lines().filter(line => line.includes(LABEL)).join(' | '), 'the Boot Settings face in src/screen/boot-face/BootSettingsScreen.tsx must list the background launch row so that moving down reaches it')
  const lines = m.lines()
  const row = rowOf(lines)
  const rowAt = lines.indexOf(row)
  check('the row sits under AGENTS after Crewmates and before JEV', rowAt > 0 && /│\s+Crewmates\s/.test(lines[rowAt - 1] ?? '') && (lines[rowAt + 1] ?? '').includes('JEV'), `${lines[rowAt - 1] ?? ''} / ${row} / ${lines[rowAt + 1] ?? ''}`, 'withJevRow in src/screen/boot-face/BootSettingsScreen.tsx must keep the row directly after Crewmates and directly before JEV')
  check("the row's value column reads off", new RegExp(`❯ ${LABEL}\\s+off\\s`).test(row), row, 'the row value column must read off while the leaf is unset; see backgroundLaunchValueWords in src/daemon/switchboard/backgroundLaunch.ts')
  const pane = paneText(lines)
  check('the detail pane names what it controls in the operator\'s words', pane.includes('What it controls') && pane.includes('Whether a session left in the background may launch crewmates when its brief says so, as a focused one does.'), pane, 'the detail pane must show the controls text of BACKGROUND_LAUNCH_MENU_ROW in src/daemon/switchboard/backgroundLaunch.ts')
  check('the pane carries the current value and the detail lines (now: off (default), the doors)', pane.includes('Current value off') && pane.includes('now: off (default)') && pane.includes('doors: /config · Boot Menu (one switch)'), pane, 'backgroundLaunchBootDetailLines in src/screen/boot-face/settings/detailLines.ts must show the current value, the now line and the doors line')
  check('the pane lists the on and off effects, whole', pane.includes('When on') && pane.includes('launches crewmates without your visit') && pane.includes('its own switch still rules first') && pane.includes('When off') && pane.includes('waits for your visit or the crewmates-allowed tag') && pane.includes('the launch refusal names this row'), pane, 'the detail pane must show the on and off lists of BACKGROUND_LAUNCH_MENU_ROW in src/daemon/switchboard/backgroundLaunch.ts')
  check('no detail line is clipped with an ellipsis', !paneLines(lines).some(line => line.endsWith('…')), paneLines(lines).filter(line => line.endsWith('…')).join(' | '), 'shorten the detail lines in src/daemon/switchboard/backgroundLaunch.ts so none is clipped at the detail width')
  await press(m, KEY.enter, 300)
  check('↵ turns it on through the one writer: the file carries the leaf true', stored() === true && setting.backgroundSessionsLaunchCrewmates() === true, String(stored()), 'commitBackgroundLaunchOf in src/screen/boot-face/settings/commits.ts must write the leaf true through setBackgroundSessionsLaunchCrewmates when enter is pressed on the row')
  const after = m.lines()
  check('the value column now reads on', new RegExp(`❯ ${LABEL}\\s+on\\s`).test(rowOf(after)), rowOf(after), 'the Boot Settings face in src/screen/boot-face/BootSettingsScreen.tsx must re-read backgroundSessionsLaunchCrewmates after the commit')
  check("the status bar carries the owner's receipt", has(after, `${LABEL} on — backgrounded sessions launch as a focused one does`), after.slice(-3).join(' | '), 'backgroundLaunchReceiptWords in src/daemon/switchboard/backgroundLaunch.ts and commitBackgroundLaunchOf in src/screen/boot-face/settings/commits.ts must produce the status bar receipt')
  check('the pane now reads now: on', paneText(after).includes('now: on'), '', 'backgroundLaunchBootDetailLines in src/screen/boot-face/settings/detailLines.ts must be rebuilt with the new value after the commit')
  check('boot-env.json never carries the switch (the row is config-backed)', !existsSync(join(HOME, 'boot-env.json')) || !readFileSync(join(HOME, 'boot-env.json'), 'utf8').includes(KEY_NAME), '', 'the row is config-backed: its commit in src/screen/boot-face/settings/commits.ts must not write the key to boot-env.json')
  await press(m, KEY.enter, 300)
  check('a second ↵ turns it off and the key leaves the file', stored() === undefined && setting.backgroundSessionsLaunchCrewmates() === false && has(m.lines(), `${LABEL} off — backgrounded sessions wait for a visit or the tag`), m.lines().slice(-3).join(' | '), 'a second enter must turn the leaf off and remove the key through setBackgroundSessionsLaunchCrewmates in src/daemon/switchboard/backgroundLaunch.ts, with the off receipt in the status bar')
  await press(m, KEY.right, 300)
  check('→ turns it on again', stored() === true, '', 'the right arrow on the row must commit on through commitBackgroundLaunchOf in src/screen/boot-face/settings/commits.ts')
  await press(m, '\x7f', 300)
  check('⌫ returns the row to its default: off, the key gone', stored() === undefined && new RegExp(`❯ ${LABEL}\\s+off\\s`).test(rowOf(m.lines())), rowOf(m.lines()), 'backspace on the row must reset it to its default off and remove the key; see src/screen/boot-face/settings/commits.ts')
  m.unmount()
  await settle(60)
}

console.log('§3 the two doors are one switch: the boot face reads what /config wrote')
{
  setting.setBackgroundSessionsLaunchCrewmates(true)
  const m = await openBootFace()
  await selectMarked(m, `❯ ${LABEL}`)
  check('the row reads on, written by the other door', new RegExp(`❯ ${LABEL}\\s+on\\s`).test(rowOf(m.lines())), rowOf(m.lines()), 'the Boot Settings face in src/screen/boot-face/BootSettingsScreen.tsx must read backgroundSessionsLaunchCrewmates from src/daemon/switchboard/backgroundLaunch.ts, the leaf /config writes')
  m.unmount()
  await settle(60)
  setting.setBackgroundSessionsLaunchCrewmates(false)
}

releaseScratchHome(HOME)
console.log(failures === 0 ? '\nprove-boot-menu-background-launch-row: ALL LAWS HOLD' : `\nprove-boot-menu-background-launch-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
