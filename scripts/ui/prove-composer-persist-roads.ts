#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('composer-persist')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_HOME = join(HOME, 'proof-home')
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREWS_DIR = join(HOME, 'teams')
process.env.BROWSER = '/usr/bin/true'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(process.env.MERCURY_HOME, { recursive: true })
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 178
const ROWS = 51
const DRAFT = 'hello'
const SECOND = 'world'
const SESSION = 'proof-session'
const AGENT_ID = 'agent-proof-1'
const AGENT_NAME = 'alpha probe'
const PLACEHOLDER = 'Type a prompt'
const CREW_TITLE = 'Mercury — crew'
const MODEL_TITLE = 'Mercury · model'
const MAIN_CHAT_FIELD = 'mainChatTaskId'
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
type CensusRow = { road: string; after: string; row: string; verdict: 'kept' | 'DROPPED' | 'not driven' }
const census: CensusRow[] = []
function record(road: string, after: string, row: string, driven = true): void {
  census.push({ road, after, row: row.trimEnd(), verdict: !driven ? 'not driven' : after === DRAFT ? 'kept' : 'DROPPED' })
}

const React = await import('react')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { useAppStateStore } = await import('../../src/state/AppState.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { REPL } = await import('../../src/screens/REPL.js')
const route = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const helm = await import('../../src/utils/cockpit/helmFocus.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
const filesMenu = await import('../../src/utils/cockpit/filesMenu.js')
const crewmateView = await import('../../src/state/crewmateViewHelpers.js')
const { createTaskStateBase } = await import('../../src/Task.js')
const promptDraft = await import('../../src/utils/promptDraft.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)
type AppStore = ReturnType<typeof useAppStateStore>
let storeTap: AppStore | null = null
function StoreTap(): null {
  storeTap = useAppStateStore()
  return null
}
const store = (): AppStore => {
  if (storeTap === null) throw new Error('the app store tap never mounted')
  return storeTap
}

slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => SESSION }))
route.initializeSurfaceRoute(route.ROOT_REPL_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})

const h = React.createElement
const frames: string[] = []
function keepFrame(name: string, m: Mounted): void {
  frames.push(name)
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), m.lines().join('\n') + '\n')
}
const composerRow = (m: Mounted): string => {
  const rows = m.lines().filter(line => /^│?❯/.test(line))
  return rows[rows.length - 1] ?? '(no composer row)'
}
async function press(m: Mounted, data: string, ms = 160): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function typeWords(m: Mounted, words: string): Promise<void> {
  for (const ch of words) await press(m, ch, 45)
  await waitFor(() => pending.text().endsWith(words), 3000)
  await settle(200)
}
async function freshDraft(m: Mounted): Promise<void> {
  if (pending.text() !== '') {
    pending.edit('')
    await settle(150)
  }
  await typeWords(m, DRAFT)
  await waitFor(() => composerRow(m).includes(DRAFT), 3000)
}
const quoted = (m: Mounted): string => `composer text ${JSON.stringify(pending.text())} · row ${composerRow(m).trimEnd()}`
async function closeWith(m: Mounted, gone: () => boolean): Promise<boolean> {
  await press(m, KEY.esc, 200)
  return waitFor(gone, 4000)
}

section('§0 the real chat at 178x51: the REPL screen and its composer in one in-process tree')
const m = await mountOffscreen(
  h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(StoreTap, null), h(SurfaceRouter, null, h(REPL, { commands, initialTools: [] }))),
  COLS,
  ROWS,
)
await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
await settle(300)
check('the composer painted its empty prompt row', composerRow(m).includes(PLACEHOLDER), composerRow(m))
check('the app store is reachable for the view moves', storeTap !== null)
await freshDraft(m)
check('the operator typed the draft through the keys and the composer paints it', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
keepFrame('00-draft-typed', m)

section('§1 the crew view (/teammates through the click door) — open, esc back')
{
  await freshDraft(m)
  helm.requestCommandDispatch('/teammates')
  const opened = await waitFor(() => m.screen().includes(CREW_TITLE), 6000)
  await settle(400)
  check('the crew view opened over the chat', opened, m.lines().filter(line => line.includes('Mercury')).join(' | '))
  const under = pending.text()
  keepFrame('01-crew-open', m)
  check('the draft is still the composer text under the crew view', under === DRAFT, quoted(m))
  check('esc closed the crew view', await closeWith(m, () => !m.screen().includes(CREW_TITLE)))
  await settle(300)
  record('crew view: /teammates open, esc back', pending.text(), composerRow(m))
  check('back from the crew view the composer still reads the draft', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  keepFrame('01-crew-closed', m)
}

section('§2 /model (through the click door) — open, esc back')
{
  await freshDraft(m)
  helm.requestCommandDispatch('/model')
  const opened = await waitFor(() => m.screen().includes(MODEL_TITLE), 8000)
  await settle(400)
  check('the model picker opened over the chat', opened, m.lines().filter(line => line.includes('Mercury')).join(' | '))
  keepFrame('02-model-open', m)
  check('the draft is still the composer text under the picker', pending.text() === DRAFT, quoted(m))
  check('esc closed the picker', await closeWith(m, () => !m.screen().includes(MODEL_TITLE)))
  await settle(300)
  record('/model: picker open, esc back', pending.text(), composerRow(m))
  check('back from the picker the composer still reads the draft', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
}

section('§3 the files menu (/files through the click door) — open, esc back')
{
  await freshDraft(m)
  helm.requestCommandDispatch('/files')
  const opened = await waitFor(() => filesMenu.isFilesMenuOpen(), 6000)
  await settle(400)
  check('the files menu opened', opened)
  keepFrame('03-files-open', m)
  check('the draft is still the composer text under the files menu', pending.text() === DRAFT, quoted(m))
  check('esc closed the files menu', await closeWith(m, () => !filesMenu.isFilesMenuOpen()))
  await settle(300)
  record('files menu: /files open, esc back', pending.text(), composerRow(m))
  check('back from the files menu the composer still reads the draft', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
}

section('§4 the /usage and /config popups — open, esc back')
{
  for (const command of ['/usage', '/config']) {
    await freshDraft(m)
    helm.requestCommandDispatch(command)
    const opened = await waitFor(() => popup.isSettingsPopupOpen(), 6000)
    await settle(400)
    check(`${command} opened its popup`, opened)
    check(`the draft is still the composer text under ${command}`, pending.text() === DRAFT, quoted(m))
    check(`esc closed ${command}`, await closeWith(m, () => !popup.isSettingsPopupOpen()))
    await settle(300)
    record(`${command} popup: open, esc back`, pending.text(), composerRow(m))
    check(`back from ${command} the composer still reads the draft`, pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  }
}

section('§5 the agent view: view in (a CREW row), esc out, view in again')
{
  await freshDraft(m)
  const task = {
    ...createTaskStateBase(AGENT_ID, 'local_agent', AGENT_NAME),
    type: 'local_agent' as const,
    agentId: AGENT_ID,
    prompt: 'work quietly',
    agentType: 'general-purpose',
    status: 'running' as const,
    isBackgrounded: true,
    messages: [],
  }
  store().setState(prev => ({ ...prev, tasks: { ...prev.tasks, [AGENT_ID]: task as never } }))
  await settle(200)
  const setAppState = (updater: (prev: ReturnType<AppStore['getState']>) => ReturnType<AppStore['getState']>): void => store().setState(updater)
  const draftOnDiskBefore = await waitFor(() => promptDraft.readDraftSync(SESSION)?.text === DRAFT, 2000)
  check('the durable draft holds the typed words before the move', draftOnDiskBefore, JSON.stringify(promptDraft.readDraftSync(SESSION)))
  crewmateView.enterCrewmateView(AGENT_ID, setAppState)
  const viewing = await waitFor(() => store().getState().viewingAgentTaskId === AGENT_ID, 3000)
  await settle(700)
  check('the view moved onto the crewmate', viewing)
  keepFrame('05-agent-view-in', m)
  record('agent view: view in (CREW row → viewingAgentTaskId)', pending.text(), composerRow(m))
  check('VIEW IN: the draft is still the composer text while the crewmate is viewed', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  const onDiskWhileViewing = promptDraft.readDraftSync(SESSION)
  check('VIEW IN: the durable draft entry survives the move (a relaunch mid-view would find it)', onDiskWhileViewing?.text === DRAFT, `durable entry ${JSON.stringify(onDiskWhileViewing)}`)
  crewmateView.exitCrewmateView(setAppState)
  const back = await waitFor(() => store().getState().viewingAgentTaskId === undefined, 3000)
  await settle(500)
  check('the view came back to the main chat', back)
  record('agent view: esc out (viewingAgentTaskId cleared)', pending.text(), composerRow(m))
  check('ESC OUT: back in the main chat the composer still reads the draft', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  keepFrame('05-agent-view-out', m)
  crewmateView.enterCrewmateView(AGENT_ID, setAppState)
  await waitFor(() => store().getState().viewingAgentTaskId === AGENT_ID, 3000)
  await settle(500)
  record('agent view: view in a second time', pending.text(), composerRow(m))
  check('a second view in keeps the draft too (no per-view pocket swaps it away)', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  crewmateView.exitCrewmateView(setAppState)
  await waitFor(() => store().getState().viewingAgentTaskId === undefined, 3000)
  await settle(400)
}

section(`§6 the main-chat switch: m on a crewmate (${MAIN_CHAT_FIELD}), view in and esc out while pinned, m on Mercury Lead`)
{
  await freshDraft(m)
  const setAppState = (updater: (prev: ReturnType<AppStore['getState']>) => ReturnType<AppStore['getState']>): void => store().setState(updater)
  store().setState(prev => ({ ...prev, [MAIN_CHAT_FIELD]: AGENT_ID }) as never)
  await settle(500)
  record('main chat: m on (the pin names a crewmate)', pending.text(), composerRow(m))
  check('M ON: the draft is still the composer text with the crewmate pinned as the main chat', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  crewmateView.enterCrewmateView(AGENT_ID, setAppState)
  await waitFor(() => store().getState().viewingAgentTaskId === AGENT_ID, 3000)
  await settle(500)
  record('main chat: view in while pinned', pending.text(), composerRow(m))
  check('VIEW IN while pinned: the draft is still the composer text', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  crewmateView.exitCrewmateView(setAppState)
  await waitFor(() => store().getState().viewingAgentTaskId === undefined, 3000)
  await settle(500)
  const pinKept = (store().getState() as Record<string, unknown>)[MAIN_CHAT_FIELD] === AGENT_ID
  record('main chat: esc out while pinned (the pin stays)', pending.text(), composerRow(m))
  check('ESC OUT while pinned: the draft is still the composer text and the pin is untouched', pending.text() === DRAFT && composerRow(m).includes(DRAFT) && pinKept, `${quoted(m)} · pin kept=${pinKept}`)
  store().setState(prev => ({ ...prev, [MAIN_CHAT_FIELD]: undefined }) as never)
  await settle(500)
  record('main chat: m off (the pin cleared, the lead is the target again)', pending.text(), composerRow(m))
  check('M OFF: the draft is still the composer text with the lead as the main chat again', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  keepFrame('06-main-chat-off', m)
}

section('§7 the faces the cockpit leaves and returns from: the concourse, the Boot face')
{
  for (const [name, enter] of [
    ['concourse', () => route.enterConcourse()],
    ['Boot face', () => route.enterBootSettings()],
  ] as const) {
    await freshDraft(m)
    const entered = enter()
    if (!entered.ok) {
      record(`${name}: leave the chat, come back`, pending.text(), `(surface not registered in this tree: ${entered.reason})`, false)
      console.log(`  NOTE the ${name} is not registered in this tree (${entered.reason}) — not driven here`)
      continue
    }
    await settle(500)
    check(`the ${name} took the frame`, route.currentSurfaceRoute().kind !== 'repl', route.currentSurfaceRoute().kind)
    keepFrame(`07-${name.replace(/\s+/g, '-').toLowerCase()}-in`, m)
    const left = route.leaveCurrentSurface()
    await settle(500)
    check(`the way back from the ${name} landed on the chat`, left.ok && route.currentSurfaceRoute().kind === 'repl', route.currentSurfaceRoute().kind)
    record(`${name}: leave the chat, come back`, pending.text(), composerRow(m))
    check(`back from the ${name} the composer still reads the draft`, pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  }
}

section('§7b the transcript (ctrl+o) unmounts the composer slot — toggle in, toggle back')
{
  await freshDraft(m)
  await press(m, '\x0f', 300)
  const inTranscript = await waitFor(() => !composerRow(m).includes(DRAFT), 4000)
  keepFrame('07-transcript-in', m)
  if (!inTranscript) {
    record('transcript: ctrl+o in, ctrl+o back', pending.text(), '(the transcript did not take the frame in this tree)', false)
    console.log('  NOTE ctrl+o did not swap the composer slot for the transcript in this tree — not driven here')
  } else {
    check('the transcript took the composer slot', inTranscript)
    await press(m, '\x0f', 300)
    const backHome = await waitFor(() => composerRow(m).includes(DRAFT) || composerRow(m).includes(PLACEHOLDER), 4000)
    await settle(300)
    check('ctrl+o again brought the composer back', backHome, composerRow(m))
    record('transcript: ctrl+o in, ctrl+o back', pending.text(), composerRow(m))
    check('back from the transcript the composer still reads the draft', pending.text() === DRAFT && composerRow(m).includes(DRAFT), quoted(m))
  }
}

section('§8 the ctrl+s pocket road: stash, type new words, open a dialog, esc back — the typed words stay, the pocket stays a pocket')
{
  await freshDraft(m)
  await press(m, '\x13', 250)
  const stashed = await waitFor(() => pending.text() === '' && pending.stashedPrompt()?.text === DRAFT, 3000)
  check('ctrl+s pocketed the draft and emptied the composer', stashed, quoted(m))
  await typeWords(m, SECOND)
  check('the operator typed new words after the stash', pending.text() === SECOND, quoted(m))
  helm.requestCommandDispatch('/model')
  const opened = await waitFor(() => m.screen().includes(MODEL_TITLE), 8000)
  await settle(400)
  check('the model picker opened over the new words', opened)
  check('esc closed the picker', await closeWith(m, () => !m.screen().includes(MODEL_TITLE)))
  await settle(400)
  const after = pending.text()
  census.push({ road: 'ctrl+s pocket + /model open, esc back (typed words after the stash)', after, row: composerRow(m).trimEnd(), verdict: after === SECOND ? 'kept' : 'DROPPED' })
  check('POCKET: the words typed after the stash are still the composer text (the pocket never pops over typed words)', after === SECOND, quoted(m))
  check('POCKET: the pocket still holds the stashed draft for ctrl+s', pending.stashedPrompt()?.text === DRAFT, JSON.stringify(pending.stashedPrompt()))
  pending.edit('')
  await settle(200)
  await press(m, '\x13', 250)
  const popped = await waitFor(() => pending.text() === DRAFT, 3000)
  check('ctrl+s on the empty composer still pops the pocket (the stash law stands)', popped && pending.stashedPrompt() === undefined, quoted(m))
  keepFrame('08-pocket-popped', m)
}

section('§9 the roads that legitimately clear: a typed submit takes the composer')
{
  pending.edit('')
  await settle(200)
  await typeWords(m, '/files')
  await press(m, KEY.enter, 300)
  const opened = await waitFor(() => filesMenu.isFilesMenuOpen(), 6000)
  await settle(300)
  check('the typed /files opened the files menu', opened)
  check('the typed line left the composer (submit clears — that law stays)', pending.text() === '', quoted(m))
  check('esc closed the files menu', await closeWith(m, () => !filesMenu.isFilesMenuOpen()))
  await settle(200)
}

section('§10 the seam in source: one owner of the text, no per-view pocket, no pop over typed words')
{
  const { readFileSync } = await import('node:fs')
  const ROOT = join(import.meta.dir, '..', '..')
  const composer = readFileSync(join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx'), 'utf8')
  const owner = readFileSync(join(ROOT, 'src', 'input-core', 'pending-input.ts'), 'utf8')
  check('POISON: the composer no longer swaps the text per viewed target', !composer.includes('takeViewDraft') && !composer.includes('stashViewDraft') && !composer.includes("from './viewDrafts.js'"))
  check('POISON: the composer writes the owner only from a keystroke, a paste, an edit door or a submit — never from an app-state change', !/useEffect\(\(\) => \{[^}]*pendingInput\.edit\(incoming\)/s.test(composer))
  check('the owner refuses to pop the pocket over typed words', /export function popStash\(\)[\s\S]*?draft\.text\.trim\(\) !== ''[\s\S]*?return undefined/.test(owner))
}

section('census')
{
  const width = Math.max(...census.map(row => row.road.length))
  for (const row of census) {
    console.log(`  ${row.road.padEnd(width)}  ${row.verdict.padEnd(10)}  after=${JSON.stringify(row.after)}  ${row.row}`)
  }
}

m.unmount()
if (frameDir !== undefined) console.log(`\nframes: ${frames.join(', ')} under ${frameDir}`)
if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? 'prove-composer-persist-roads: ALL PASS' : `prove-composer-persist-roads: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
