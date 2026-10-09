#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-background-launch-row')
delete process.env.MERCURY_CONCOURSE_WORKER

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs, getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
const { evaluateLaunchAuthority } = await import('../../src/services/switchboard/launchAuthority.js')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.js')
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
const LIST_FIRST = TOP + 6
const ROW = 'Crewmates while backgrounded'
const KEY_NAME = 'backgroundSessionsLaunchCrewmates'
const FILE = join(HOME, '.mercury.json')

const recDir = mkdtempSync(join(tmpdir(), 'config-bglaunch-records-'))
const sid = '550e8400-e29b-41d4-a716-4466554400e3'
updateConcourseWorkers(ws => {
  ws['concourse-w1'] = { schema: 1, runnerId: 'concourse-w1', sessionId: sid, workspaceId: HOME, isolation: 'exclusive', modelKey: 'claude-fable-5', spawnedAt: 1, lastLiveAt: Date.now() }
}, recDir)
const valve = () => evaluateLaunchAuthority('subagents', { roleEnvOn: true, dir: recDir, sessionId: sid })
const stored = (): unknown => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>)[KEY_NAME] : undefined)

async function openPopup(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  return m
}
const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
const listRows = (m: Mounted, count: number): string[] => Array.from({ length: count }, (_, i) => innerOf(m.lines()[LIST_FIRST + i] ?? '').trim())
const labelOf = (row: string): string => row.replace(`${CONFIG_ROW_MARK} `, '').slice(0, 34).trim()
const rowLine = (m: Mounted): string => listRows(m, 1)[0] ?? ''
const belowRow = (m: Mounted): string =>
  [TOP + 7, TOP + 8, TOP + 9, TOP + 10]
    .map(index => innerOf(m.lines()[index] ?? '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
const shown = (m: Mounted): string => rowLine(m).replace(`${CONFIG_ROW_MARK} ${ROW}`, '').trim()
async function search(m: Mounted, words: string): Promise<void> {
  m.push('/')
  await settle(60)
  for (const ch of words) {
    m.push(ch)
    await settle(25)
  }
  await settle(100)
  m.push(KEY.down)
  await settle(160)
}

console.log('§1 the row sits with the crewmate rows and reads off by default')
{
  const m = await openPopup()
  await search(m, 'crewmates')
  const labels = listRows(m, 8).filter(row => row !== '').map(labelOf)
  const at = labels.indexOf(ROW)
  check('the search for crewmates finds the row', at !== -1, labels.join(' | '))
  check('it follows Crewmates at once, the last of the crewmate default rows', at > 0 && labels[at - 1] === 'Crewmates at once', labels.join(' | '))
  await search(m, '')
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
  await settle(40)
}

console.log('§2 selected, the row explains itself; → turns it on and the valve admits a backgrounded worker at once')
{
  check('a fresh home stores nothing for the leaf', stored() === undefined, String(stored()))
  check('the valve refuses a backgrounded, unfocused, untagged worker while the setting is off', !valve().allowed)
  const m = await openPopup()
  await search(m, 'backgrounded')
  check('the row is the one selected', rowLine(m).startsWith(`${CONFIG_ROW_MARK} ${ROW}`), rowLine(m))
  check('its value reads off', shown(m) === 'off', rowLine(m))
  check('the selected row explains what it does and what stays as it was', belowRow(m).includes('whether a session you have left in the background may launch crewmates and workflows when its brief says so') && belowRow(m).includes("the session's own Crewmates and Workflows switches still rule first") && belowRow(m).includes('doors: /config · Boot Menu (one switch)'), belowRow(m))
  m.push(KEY.right)
  await settle(200)
  check('→ turns it on: the row reads on', shown(m) === 'on', rowLine(m))
  check('the leaf is written true through its one writer', stored() === true && getGlobalConfig()[KEY_NAME] === true, String(stored()))
  const admitted = valve()
  check('the valve now admits the same worker with the posture background-by-setting', admitted.allowed && admitted.posture === 'background-by-setting', JSON.stringify(admitted))
  m.push(KEY.right)
  await settle(200)
  check('→ again turns it off: the row reads off and the leaf leaves the file', shown(m) === 'off' && stored() === undefined, `${rowLine(m)} · stored=${String(stored())}`)
  check('the valve refuses again', !valve().allowed)
  m.push(KEY.right)
  await settle(200)
  check('on once more before the escape', stored() === true)
  m.push(KEY.esc)
  await settle(200)
  check('esc reverts the unsaved change: the leaf is gone and the valve refuses', stored() === undefined && !valve().allowed, String(stored()))
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
  await settle(40)
}

console.log('§3 ↵ saves: the choice outlives the popup')
{
  const m = await openPopup()
  await search(m, 'backgrounded')
  m.push(KEY.right)
  await settle(200)
  m.push(KEY.enter)
  await settle(200)
  check('the popup closed on ↵', !m.screen().includes(CONFIG_POPUP_HINT))
  check('the leaf stays true after the save', stored() === true && valve().allowed, String(stored()))
  m.unmount()
  await settle(40)
}

releaseScratchHome(HOME)
console.log(failures === 0 ? '\nprove-config-background-launch-row: ALL LAWS HOLD' : `\nprove-config-background-launch-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
