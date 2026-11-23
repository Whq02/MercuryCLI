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
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}

const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/screen/settings/Config.js')
const { enableConfigs, getGlobalConfig } = await import('../../src/platform/config/globalConfig.js')
const { evaluateLaunchAuthority } = await import('../../src/daemon/switchboard/launchAuthority.js')
const { updateConcourseWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
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
  check('the search for crewmates finds the row', at !== -1, labels.join(' | '), 'the row must be registered in src/screen/settings/config/configRowsCrew.tsx with the label BACKGROUND_LAUNCH_LABEL from src/daemon/switchboard/backgroundLaunch.ts')
  check('it follows Crewmates at once, the last of the crewmate default rows', at > 0 && labels[at - 1] === 'Crewmates at once', labels.join(' | '), 'move the row so it sits right after Crewmates at once in the crewmate rows of src/screen/settings/config/configRowsCrew.tsx')
  await search(m, '')
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
  await settle(40)
}

console.log('§2 selected, the row explains itself; → turns it on and the valve admits a backgrounded worker at once')
{
  check('a fresh home stores nothing for the leaf', stored() === undefined, String(stored()), 'backgroundSessionsLaunchCrewmates must stay absent from the config file until the row is toggled; check src/daemon/switchboard/backgroundLaunch.ts')
  check('the valve refuses a backgrounded, unfocused, untagged worker while the setting is off', !valve().allowed, '', 'evaluateLaunchAuthority in src/daemon/switchboard/launchAuthority.ts must return allowed false for a background worker when backgroundSessionsLaunchCrewmates() is off')
  const m = await openPopup()
  await search(m, 'backgrounded')
  check('the row is the one selected', rowLine(m).startsWith(`${CONFIG_ROW_MARK} ${ROW}`), rowLine(m), 'the popup search then down must land on the row labelled BACKGROUND_LAUNCH_LABEL; check src/screen/settings/config/configRowsCrew.tsx and the search in src/screen/settings/Config.tsx')
  check('its value reads off', shown(m) === 'off', rowLine(m), 'the row value in src/screen/settings/config/configRowsCrew.tsx must come from backgroundLaunchValueWords for the default off setting')
  check('the selected row explains what it does and what stays as it was', belowRow(m).includes('whether a session you have left in the background may launch crewmates when its brief says so') && belowRow(m).includes("the session's own Crewmates switch still rules first") && belowRow(m).includes('doors: /config · Boot Menu (one switch)'), belowRow(m), 'the selected-row note must carry the text of BACKGROUND_LAUNCH_NOTE and BACKGROUND_LAUNCH_DOORS in src/daemon/switchboard/backgroundLaunch.ts, shown by src/screen/settings/config/configRowsCrew.tsx')
  m.push(KEY.right)
  await settle(200)
  check('→ turns it on: the row reads on', shown(m) === 'on', rowLine(m), 'the right key on the row must call setBackgroundSessionsLaunchCrewmates(true) from src/daemon/switchboard/backgroundLaunch.ts in src/screen/settings/config/configRowsCrew.tsx')
  check('the leaf is written true through its one writer', stored() === true && getGlobalConfig()[KEY_NAME] === true, String(stored()), 'setBackgroundSessionsLaunchCrewmates in src/daemon/switchboard/backgroundLaunch.ts must write the leaf through saveGlobalConfig in src/platform/config/globalConfig.ts')
  const admitted = valve()
  check('the valve now admits the same worker with the posture background-by-setting', admitted.allowed && admitted.posture === 'background-by-setting', JSON.stringify(admitted), 'evaluateLaunchAuthority in src/daemon/switchboard/launchAuthority.ts must read backgroundSessionsLaunchCrewmates() after the focused and tagged checks and return the background-by-setting posture')
  m.push(KEY.right)
  await settle(200)
  check('→ again turns it off: the row reads off and the leaf leaves the file', shown(m) === 'off' && stored() === undefined, `${rowLine(m)} · stored=${String(stored())}`, 'turning the row off must remove the leaf from the config file rather than store false; check setBackgroundSessionsLaunchCrewmates in src/daemon/switchboard/backgroundLaunch.ts')
  check('the valve refuses again', !valve().allowed, '', 'evaluateLaunchAuthority in src/daemon/switchboard/launchAuthority.ts must read the setting afresh each call, not cache it')
  m.push(KEY.right)
  await settle(200)
  check('on once more before the escape', stored() === true, '', 'the right key on the row in src/screen/settings/config/configRowsCrew.tsx must write the leaf true again')
  m.push(KEY.esc)
  await settle(200)
  check('esc reverts the unsaved change: the leaf is gone and the valve refuses', stored() === undefined && !valve().allowed, String(stored()), 'the escape revert in src/screen/settings/config/useConfigExits.ts must restore the leaf recorded by the row write in src/screen/settings/config/useConfigWrites.ts')
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
  check('the popup closed on ↵', !m.screen().includes(CONFIG_POPUP_HINT), '', 'the enter key must save and close the popup; check saveAndClose in src/screen/settings/config/useConfigExits.ts')
  check('the leaf stays true after the save', stored() === true && valve().allowed, String(stored()), 'saveAndClose in src/screen/settings/config/useConfigExits.ts must keep the leaf written by the row, and evaluateLaunchAuthority in src/daemon/switchboard/launchAuthority.ts must then allow the worker')
  m.unmount()
  await settle(40)
}

releaseScratchHome(HOME)
console.log(failures === 0 ? '\nprove-config-background-launch-row: ALL LAWS HOLD' : `\nprove-config-background-launch-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
