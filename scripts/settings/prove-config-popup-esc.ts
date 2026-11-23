#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
pinSourceRef()
const HOME = pinScratchHome('mercury-config-popup-esc')
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
const bootstrap = await import('../../src/boot/process-state/processState.js')
bootstrap.setOriginalCwd(PROJECT)
bootstrap.setProjectRoot(PROJECT)
bootstrap.setCwdState(PROJECT)
const localCatalogue = await import('../../src/models/roads/local/localCatalogue.js')
mock.module('../../src/models/roads/local/localCatalogue.js', () => ({
  ...localCatalogue,
  localRecordFor: (id: string) => id === 'local/undo-fixture' ? { id: 'undo-fixture', server: 'ollama', modelMaxContext: 131072 } : undefined,
}))

let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider, getDefaultAppState, useAppStateStore } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_SEARCH_PLACEHOLDER, CONFIG_ROW_MARK } = await import('../../src/screen/settings/Config.js')
const { settingsPopupReceipt } = await import('../../src/screen/settings/Settings.js')
const { enableConfigs, getGlobalConfig } = await import('../../src/platform/config/globalConfig.js')
const { escapeFromOutsidePress } = await import('../../src/screen/renderer/recessLayer.js')
const OUTSIDE_PRESS = '\x1b[<0;2;2M'
const OUTSIDE_RELEASE = '\x1b[<0;2;2m'
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
type Notice = { key?: string; text: string; priority?: string }
let notices: Notice[] = []
function NoticeTap(): null {
  const appState = useAppStateStore()
  React.useLayoutEffect(() => {
    const read = (): void => {
      const held = appState.getState().notifications as { current?: Notice | null; queue?: Notice[] } | undefined
      const current = held?.current
      if (current && !notices.some(n => n.text === current.text)) notices.push(current)
      for (const queued of held?.queue ?? []) if (!notices.some(n => n.text === queued.text)) notices.push(queued)
    }
    read()
    return appState.subscribe(read)
  }, [appState])
  return null
}

async function openPopup(model?: string): Promise<Mounted> {
  notices = []
  const element = React.createElement(
    AppStateProvider as never,
    {
      ...(model ? { initialState: { ...getDefaultAppState(), engineModel: model } } : {}),
    },
    React.createElement(NoticeTap),
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  return m
}
const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
const firstRow = (m: Mounted): string => innerOf(m.lines()[TOP + 6] ?? '').trim()
const searchRow = (m: Mounted): string => innerOf(m.lines()[TOP + 4] ?? '').trim()
const popupUp = (m: Mounted): boolean => store.isSettingsPopupOpen() && m.screen().includes(CONFIG_POPUP_HINT)
const savedAutoCompact = (): string => {
  const value = getGlobalConfig().autoCompactEnabled
  return value === undefined ? 'unset' : String(value)
}

section('a live config write refreshes the displayed choice without reopening')
{
  const { saveGlobalConfig, readGlobalConfigAgain } = await import('../../src/platform/config/globalConfig.js')
  const m = await openPopup()
  await settle(200)
  const before = getGlobalConfig().autoCompactEnabled
  saveGlobalConfig(current => ({ ...current, autoCompactEnabled: false }))
  readGlobalConfigAgain()
  await settle(160)
  check('an external config write updates the displayed row', firstRow(m).endsWith('off'), firstRow(m), 'the popup in src/screen/settings/Config.tsx must re-read the global config when it changes (the rows are built in src/screen/settings/config/configRowsView.tsx)')
  saveGlobalConfig(current => ({ ...current, autoCompactEnabled: before }))
  await settle(160)
  m.unmount()
  store.closeSettingsPopup()
}

section('§1 a clean config: esc closes')
{
  const m = await openPopup()
  check('the popup opens in list mode with row 0 selected', firstRow(m).startsWith(`${CONFIG_ROW_MARK} Auto-compact`) && firstRow(m).endsWith('on'), firstRow(m), 'the first list row must be the Auto-compact row from src/screen/settings/config/configRowsView.tsx, selected and reading on')
  m.push(KEY.esc)
  await settle(120)
  check('one esc closes the popup', !store.isSettingsPopupOpen() && !m.screen().includes(CONFIG_POPUP_HINT), '', 'the escape handler in src/screen/settings/config/useConfigExits.ts must call onClose when nothing is dirty and no search is open')
  check('a dismissal posts no receipt', notices.length === 0, JSON.stringify(notices), 'escape in src/screen/settings/config/useConfigExits.ts must call onClose(undefined) so settingsPopupReceipt in src/screen/settings/Settings.tsx posts nothing')
  m.unmount()
  await settle(40)
}

section('§2 a dirty config: esc reverts and stays, a second esc closes')
{
  const before = savedAutoCompact()
  const m = await openPopup()
  m.push(KEY.right)
  await settle(120)
  check('→ on Auto-compact toggles the row to off (the write lands at once)', firstRow(m).endsWith('off') && savedAutoCompact() === 'false', `${firstRow(m)} · saved ${savedAutoCompact()}`, 'the right key on the Auto-compact row in src/screen/settings/config/configRowsView.tsx must toggle it and write autoCompactEnabled at once')
  m.push(KEY.esc)
  await settle(160)
  check('the first esc REVERTS the change and the popup STAYS', popupUp(m) && firstRow(m).endsWith('on'), `${firstRow(m)} · open ${store.isSettingsPopupOpen()}`, 'escape in src/screen/settings/config/useConfigExits.ts must call revert and return without closing while changes are recorded')
  check('the saved key is back to its mount-time value', savedAutoCompact() === before, `${savedAutoCompact()} vs ${before}`, 'revert in src/screen/settings/config/useConfigExits.ts must replay the undo entries recorded by src/screen/settings/config/useConfigWrites.ts')
  check('row 0 is still the selected row after the revert', firstRow(m).startsWith(`${CONFIG_ROW_MARK} `), '', 'the selection in src/screen/settings/Config.tsx must survive the revert')
  m.push(KEY.esc)
  await settle(120)
  check('the second esc closes', !store.isSettingsPopupOpen(), '', 'escape in src/screen/settings/config/useConfigExits.ts must close once the revert left nothing dirty')
  check('no receipt on the dismissal', notices.length === 0, JSON.stringify(notices), 'escape in src/screen/settings/config/useConfigExits.ts must close with onClose(undefined), not a summary')
  m.unmount()
  await settle(40)
}

section('§2b the sessions row (local) and the pinned-memory row (user) move back on esc like every other row')
{
  const settings = await import('../../src/platform/settings/settings.js')
  const savedSessions = (): unknown => settings.getSettingsForSource('localSettings')?.shell?.sessions
  const savedPinned = (): unknown => settings.getSettingsForSource('userSettings')?.memory?.pinnedLimit
  const typeQuery = async (m: Mounted, query: string): Promise<void> => {
    m.push('/')
    await settle(60)
    for (const ch of query) {
      m.push(ch)
      await settle(30)
    }
    await settle(120)
  }
  for (const leg of [
    { row: 'Shell engine sessions', query: 'shell engine sessions', saved: savedSessions, key: 'shell.sessions (local)' },
    { row: 'Pinned memory limit', query: 'pinned memory limit', saved: savedPinned, key: 'memory.pinnedLimit (user)' },
  ]) {
    const before = leg.saved()
    const m = await openPopup()
    await typeQuery(m, leg.query)
    m.push(KEY.down)
    await settle(120)
    check(`the search then ↓ selects the ${leg.row} row`, firstRow(m).startsWith(`${CONFIG_ROW_MARK} ${leg.row}`), firstRow(m), 'the popup search in src/screen/settings/Config.tsx must find the row labelled with the leg row name')
    m.push(KEY.right)
    await settle(200)
    check(`→ moves ${leg.key} and the write lands at once`, leg.saved() !== before && leg.saved() !== undefined, `${String(leg.saved())} vs ${String(before)}`, 'the right key on this row must write its setting through the writers in src/screen/settings/config/useConfigWrites.ts')
    m.push(KEY.esc)
    await settle(200)
    check(`the first esc REVERTS ${leg.key} to its mount-time value and the popup stays`, popupUp(m) && leg.saved() === before, `${String(leg.saved())} vs ${String(before)} · open ${store.isSettingsPopupOpen()}`, 'this row must record an undo entry in src/screen/settings/config/useConfigWrites.ts that revert in src/screen/settings/config/useConfigExits.ts replays')
    m.push(KEY.esc)
    await settle(120)
    check('the second esc closes', !store.isSettingsPopupOpen(), '', 'escape in src/screen/settings/config/useConfigExits.ts must close once the revert left nothing dirty')
    m.unmount()
    await settle(40)
  }
}

const settings = await import('../../src/platform/settings/settings.js')
const { saveGlobalConfig } = await import('../../src/platform/config/globalConfig.js')
const userFile = join(HOME, 'settings.json')
const localFile = settings.getSettingsFilePathForSource('localSettings')!
const rawUser = (): Record<string, any> => JSON.parse(readFileSync(userFile, 'utf8'))
const rawLocal = (): Record<string, any> => JSON.parse(readFileSync(localFile, 'utf8'))
async function selectRow(m: Mounted, query: string): Promise<void> {
  m.push(query)
  await settle(120)
  m.push(KEY.down)
  await settle(100)
  check(`selected ${query}`, firstRow(m).startsWith(CONFIG_ROW_MARK), firstRow(m), 'the typed query must match a row label in src/screen/settings/Config.tsx and the down key must select it')
}

section('§2c each written leaf returns to its previous layer, even after a toggle back')
{
  settings.updateSettingsForSource('userSettings', { memory: { embeddingModel: 'previous-ranking', journal: false, journalOnEntryPage: false }, activity: { progress: true }, view: { ping: false } })
  settings.updateSettingsForSource('localSettings', { view: { ping: true, reducedMotion: true }, shell: { sessions: 4 } })
  const m = await openPopup('local/undo-fixture')
  for (const query of ['session journal', 'journal on the entry page', 'memory recall ranking', 'terminal progress bar', 'local model window']) {
    await selectRow(m, query)
    m.push(KEY.right)
    await settle(160)
  }
  check('the omitted leaves were actually changed', rawUser().memory.embeddingModel !== 'previous-ranking' && rawUser().memory.journal === true && rawUser().memory.journalOnEntryPage === true && rawUser().activity.progress === false && getGlobalConfig().localModelWindows?.['local/undo-fixture'] !== undefined, '', 'one of the five rows (session journal, journal on the entry page, memory recall ranking, terminal progress bar, local model window) did not write on the right key; check its row in src/screen/settings/config')
  await selectRow(m, 'zen mode')
  m.push(KEY.right)
  await settle(120)
  m.push(KEY.right)
  await settle(120)
  settings.updateSettingsForSource('userSettings', { view: { ping: true }, memory: { startLimit: 9000 }, guardrails: { allow: ['Read'] } })
  settings.updateSettingsForSource('localSettings', { shell: { sessions: 8 } })
  saveGlobalConfig(c => ({ ...c, localModelWindows: { ...c.localModelWindows, 'local/sibling': 65536 } }))
  m.push(KEY.esc)
  await settle(240)
  const user = rawUser()
  const local = rawLocal()
  check('Escape restores embeddingModel, journal and journalOnEntryPage', user.memory.embeddingModel === 'previous-ranking' && user.memory.journal === false && user.memory.journalOnEntryPage === false, JSON.stringify(user.memory), 'revert in src/screen/settings/config/useConfigExits.ts must restore each leaf the rows wrote to its previous layer, using restoreConfigLeaf and the undo entries from src/screen/settings/config/useConfigWrites.ts')
  check('Escape restores the user progress leaf', user.activity.progress === true, '', 'revert in src/screen/settings/config/useConfigExits.ts must replay the undo entry of the terminal progress bar row')
  check('Escape removes only this model window and keeps another model written while open', getGlobalConfig().localModelWindows?.['local/undo-fixture'] === undefined && getGlobalConfig().localModelWindows?.['local/sibling'] === 65536, '', 'revert in src/screen/settings/config/useConfigExits.ts must undo only the undo-fixture model window leaf, not rewrite the whole localModelWindows map')
  check('a toggled-back setting restores its original absence', !Object.hasOwn(user.view, 'zen'), '', 'the undo entry kept for zen mode must hold its first previous value (absent), not the value after the toggle back; check src/screen/settings/config/useConfigWrites.ts')
  check('untouched user leaves written while open survive', user.view.ping === true && user.memory.startLimit === 9000 && JSON.stringify(user.guardrails.allow) === '["Read"]', '', 'revert in src/screen/settings/config/useConfigExits.ts must touch only the leaves the popup wrote, so user leaves written by others while open survive')
  check('untouched project-local leaves and their user split survive', local.shell.sessions === 8 && local.view.ping === true && local.view.reducedMotion === true, '', 'revert in src/screen/settings/config/useConfigExits.ts must keep project-local leaves it did not write')
  check('the revert leaves the popup open', popupUp(m), '', 'the first escape in src/screen/settings/config/useConfigExits.ts must revert and return without closing')
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
}

section('§2d the undo value is the value at write time, and nested siblings survive')
{
  const m = await openPopup()
  settings.updateSettingsForSource('userSettings', { view: { accountIdentity: false } })
  await selectRow(m, 'account identity')
  m.push(KEY.right)
  await settle(160)
  check('the account identity write lands', rawUser().view.accountIdentity === undefined, '', 'the right key on the account identity row must write through src/screen/settings/config/useConfigWrites.ts')
  saveGlobalConfig(c => ({ ...c, agents: { defaultEffort: 'high' } }))
  await selectRow(m, 'crewmate default effort')
  m.push(KEY.right)
  await settle(160)
  saveGlobalConfig(c => ({ ...c, agents: { ...c.agents, maxConcurrent: 11 } }))
  m.push(KEY.esc)
  await settle(200)
  check('Escape uses the pre-write value, not the value when the popup opened', rawUser().view.accountIdentity === false, '', 'the undo entry in src/screen/settings/config/useConfigWrites.ts must capture the value at write time, not at mount')
  check('nested global undo preserves the sibling and restores just the effort', getGlobalConfig().agents?.defaultEffort === 'high' && getGlobalConfig().agents?.maxConcurrent === 11, '', 'revert in src/screen/settings/config/useConfigExits.ts must restore only agents.defaultEffort through restoreConfigLeaf and keep its sibling keys')
  m.push(KEY.esc)
  await settle(100)
  m.unmount()
}

section('§2e owner-setter undo reads the locked file, not a stale cache')
{
  const { getGlobalMercuryFile } = await import('../../src/platform/environment/env.js')
  const m = await openPopup('local/undo-fixture')
  await selectRow(m, 'local model window')
  const file = getGlobalMercuryFile()
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  disk.localModelWindows = { ...disk.localModelWindows, 'local/undo-fixture': 32768, 'local/peer': 131072 }
  writeFileSync(file, JSON.stringify(disk))
  m.push(KEY.right)
  await settle(120)
  m.push(KEY.esc)
  await settle(160)
  check('the owner-setter undo restores the real pre-write value and leaves the peer alone', getGlobalConfig().localModelWindows?.['local/undo-fixture'] === 32768 && getGlobalConfig().localModelWindows?.['local/peer'] === 131072, '', 'the undo entry for the local model window row must be read from the locked file at write time (src/screen/settings/config/useConfigWrites.ts), and revert must leave the peer key alone')
  m.push(KEY.esc)
  await settle(100)
  m.unmount()
}

section('§3 enter saves and closes with the summary receipt')
{
  const before = savedAutoCompact()
  const m = await openPopup()
  m.push(KEY.right)
  await settle(120)
  m.push(KEY.enter)
  await settle(160)
  check('↵ closes the popup', !store.isSettingsPopupOpen(), '', 'saveAndClose in src/screen/settings/config/useConfigExits.ts must call onClose after the save')
  check('the change stays saved', savedAutoCompact() === 'false', savedAutoCompact(), 'saveAndClose in src/screen/settings/config/useConfigExits.ts must not revert; the row write already landed')
  check('the one-line summary rides the notification channel under the command key', notices.some(n => n.key === 'command-config' && n.text === 'set auto-compact to off' && n.priority === 'immediate'), JSON.stringify(notices), 'composeSummary in src/screen/settings/config/useConfigExits.ts must return the recorded line and settingsPopupReceipt in src/screen/settings/Settings.tsx must post it under the command-config key')
  m.unmount()
  await settle(40)
  const undo = await openPopup()
  undo.push(KEY.right)
  await settle(120)
  undo.push(KEY.enter)
  await settle(160)
  check('the mirror change restores the key for the next leg', savedAutoCompact() === before || (before === 'unset' && savedAutoCompact() === 'true'), savedAutoCompact(), 'the second popup toggle on the Auto-compact row (src/screen/settings/config/configRowsView.tsx) must write the key back')
  undo.unmount()
  await settle(40)
}

section('§4 a click outside with an unsaved change reverts AND closes (a dismissal never saves)')
{
  const before = savedAutoCompact()
  const m = await openPopup()
  m.push(KEY.right)
  await settle(120)
  check('the toggle landed', firstRow(m).endsWith('off'), '', 'the right key on the Auto-compact row in src/screen/settings/config/configRowsView.tsx must toggle it')
  check('the flag reads false outside a press', escapeFromOutsidePress() === false, '', 'escapeFromOutsidePress in src/screen/renderer/recessLayer.ts must be false until a press outside the frame is being handled')
  m.push(OUTSIDE_PRESS)
  await settle(160)
  check('a mouse press outside the frame closes the popup in one go (the real road: the press sends the escape)', !store.isSettingsPopupOpen(), '', 'escape in src/screen/settings/config/useConfigExits.ts must revert and then call onClose when escapeFromOutsidePress() is true (src/screen/renderer/recessLayer.ts)')
  m.push(OUTSIDE_RELEASE)
  await settle(40)
  check('…and the change is reverted on disk', savedAutoCompact() === before, `${savedAutoCompact()} vs ${before}`, 'the outside-press branch of escape in src/screen/settings/config/useConfigExits.ts must call revert before onClose')
  check('the flag is cleared after the press', escapeFromOutsidePress() === false, '', 'src/screen/renderer/recessLayer.ts must clear the outside-press flag once the press has been dispatched')
  check('no receipt', notices.length === 0, JSON.stringify(notices), 'a dismissal must close with onClose(undefined) in escape of src/screen/settings/config/useConfigExits.ts')
  m.unmount()
  await settle(40)
}

section('§5 search mode: esc clears the query first; the outside press still dismisses')
{
  const m = await openPopup()
  m.push('/')
  await settle(60)
  m.push('t')
  await settle(40)
  m.push('h')
  await settle(80)
  check('/ then typing filters the list', searchRow(m).startsWith('/ th') && !firstRow(m).startsWith(`${CONFIG_ROW_MARK} `), `${searchRow(m)} · ${firstRow(m)}`, 'the slash key and typed letters must open search and filter the list; check useConfigList and useConfigKeys behind src/screen/settings/Config.tsx')
  m.push(KEY.esc)
  await settle(100)
  check('esc clears the query and the popup stays', popupUp(m) && searchRow(m) === `/ ${CONFIG_SEARCH_PLACEHOLDER}`, searchRow(m), 'escape in src/screen/settings/config/useConfigExits.ts must clear the query first (setQuery) and return without closing')
  m.push(KEY.esc)
  await settle(120)
  check('esc on the empty clean search closes', !store.isSettingsPopupOpen(), '', 'escape in src/screen/settings/config/useConfigExits.ts must leave search mode and call onClose when the query is empty and nothing is dirty')
  m.unmount()
  await settle(40)
  const n = await openPopup()
  n.push('/')
  await settle(60)
  n.push('a')
  await settle(60)
  n.push(OUTSIDE_PRESS)
  await settle(120)
  check('an outside press in search mode closes at once', !store.isSettingsPopupOpen(), '', 'the outside-press branch of escape in src/screen/settings/config/useConfigExits.ts must run before the search-mode branches')
  n.push(OUTSIDE_RELEASE)
  await settle(40)
  n.unmount()
  await settle(40)
}

section('§6 the receipt seam and the outside-press seam')
{
  const posted: Notice[] = []
  const rows: string[] = []
  check('no summary posts nothing', settingsPopupReceipt('config', '', n => posted.push(n), {}) === 'none' && posted.length === 0, '', 'settingsPopupReceipt in src/screen/settings/Settings.tsx must return none for an empty summary')
  check('one line posts a notification under the command key, priority immediate', settingsPopupReceipt('config', 'set tips to off', n => posted.push(n), {}) === 'notification' && posted[0]?.key === 'command-config' && posted[0]?.priority === 'immediate', '', 'the single-line branch of settingsPopupReceipt in src/screen/settings/Settings.tsx must post key command-config with priority immediate')
  const painted = settingsPopupReceipt('config', 'set tips to off\nset motion to full', n => posted.push(n), { addDisplayRow: row => rows.push(JSON.stringify(row)) })
  check('several lines paint the two display rows on a chat that paints rows', painted === 'rows' && rows.length === 2 && rows[1]!.includes('set tips to off') && rows[1]!.includes('set motion to full'), '', 'the several-lines branch of settingsPopupReceipt in src/screen/settings/Settings.tsx must call addDisplayRow twice with the summary in the second row')
  check('several lines on the blank chat fall back to one notification', settingsPopupReceipt('config', 'a\nb', n => posted.push(n), {}) === 'notification' && posted.length === 2, '', 'settingsPopupReceipt in src/screen/settings/Settings.tsx must fall back to one notification when the chat has no addDisplayRow')
}

await releaseScratchHome(HOME)
console.log(`\nprove-config-popup-esc: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
