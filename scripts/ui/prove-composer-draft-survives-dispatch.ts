#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('composer-draft-dispatch')
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
process.env.MERCURY_TEAMS_DIR = join(HOME, 'teams')
process.env.MERCURY_TABULA_DIR = join(HOME, 'tabula')
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
const DRAFT = '[Pasted text #1 +2 lines] the quick brown fox'
const PASTES = { 1: { id: 1, type: 'text' as const, content: 'alpha\nbeta\ngamma' } }
const PLACEHOLDER = 'Type a prompt'
const USAGE_TITLE = 'Mercury · usage'
const PALETTE_TITLE = 'Mercury — command palette'
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

const React = await import('react')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { REPL } = await import('../../src/screens/REPL.js')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const helm = await import('../../src/utils/cockpit/helmFocus.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
const history = await import('../../src/history.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
markDaemonHaltStanddown()
type Cmd = { name: string; load: () => Promise<{ call: (...args: unknown[]) => unknown }> }
let usageRuns = 0
const commands = (await getCommands(PROJECT)).map(command => {
  if (command.name !== 'usage') return command
  const real = command as unknown as Cmd
  return {
    ...command,
    load: async () => {
      const module = await real.load()
      return { ...module, call: (...args: unknown[]) => { usageRuns++; return module.call(...args) } }
    },
  }
})

slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => 'proof-session' }))
initializeSurfaceRoute(ROOT_REPL_ROUTE)
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
const composerRow = (m: Mounted): string => m.lines().find(line => line.startsWith('│❯')) ?? '(no composer row)'
async function caretAt(m: Mounted, x: number): Promise<boolean> {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const y = m.lines().findIndex(line => line.startsWith('│❯'))
    if (y >= 0 && m.styleAt(x, y)?.inverse === true) return true
    await settle(40)
  }
  return false
}
const samePastes = (): boolean => JSON.stringify(pending.pastedContents()) === JSON.stringify(PASTES)
async function press(m: Mounted, data: string, ms = 160): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function closePopup(m: Mounted): Promise<boolean> {
  await press(m, KEY.esc, 200)
  return waitFor(() => !popup.isSettingsPopupOpen(), 3000)
}

section('§0 the real chat at 178x51: the REPL screen, its composer and the telemetry rail in one in-process tree')
const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(REPL, { commands, initialTools: [] }))), COLS, ROWS)
await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
await settle(300)
check('the composer painted its empty prompt row', composerRow(m).includes(PLACEHOLDER), composerRow(m))
check('the telemetry rail published the usage row the pointer activates', helm.getHelmRows('telemetry').some(row => row.label === 'usage:spend'), helm.getHelmRows('telemetry').map(row => row.label).join(','))
check('no usage surface is open and nothing has run', !popup.isSettingsPopupOpen() && usageRuns === 0)

section('§1 a draft with a paste and a mid-text caret')
pending.edit(DRAFT)
pending.setPastedContents(PASTES)
await waitFor(() => composerRow(m).includes(DRAFT), 3000)
for (let i = 0; i < 4; i++) await press(m, KEY.left, 60)
await settle(250)
const caretBefore = 3 + DRAFT.length - 4
const rowBefore = composerRow(m)
check('the draft is painted in the composer', rowBefore.includes(DRAFT), rowBefore)
check('the caret sits four cells before the end of the draft', await caretAt(m, caretBefore), `no caret at column ${caretBefore}`)
keepFrame('draft-before-click-178x51', m)

section('§2 the USAGE card road (requestCommandDispatch): the popup opens, the draft, its caret and its paste stay')
helm.requestCommandDispatch('/usage')
const opened = await waitFor(() => popup.isSettingsPopupOpen(), 5000)
await settle(400)
check('the usage popup opened and the command ran once', opened && m.screen().includes(USAGE_TITLE) && usageRuns === 1, `open=${opened} runs=${usageRuns}`)
check('the draft is still the composer text under the popup', pending.text() === DRAFT, `composer text ${JSON.stringify(pending.text())} · row ${composerRow(m).trimEnd()}`)
check('the paste map is untouched under the popup', samePastes(), JSON.stringify(pending.pastedContents()))
keepFrame('usage-popup-over-draft-178x51', m)
check('esc closed the popup', await closePopup(m))
await settle(300)
check('after esc the composer row reads the draft again', composerRow(m) === rowBefore, `row ${composerRow(m).trimEnd()}`)
check('after esc the caret is back where it was', await caretAt(m, caretBefore), `no caret at column ${caretBefore}`)
check('after esc the paste map is still the same', samePastes(), JSON.stringify(pending.pastedContents()))
keepFrame('draft-after-esc-178x51', m)

section('§3 the usage ROW road (a rail activation): the same seam, the same law')
helm.requestHelmRowActivationByLabel('telemetry', 'usage:spend')
const openedByRow = await waitFor(() => popup.isSettingsPopupOpen(), 5000)
await settle(400)
check('the row activation opened the popup and ran the command once more', openedByRow && usageRuns === 2, `open=${openedByRow} runs=${usageRuns}`)
check('the draft survived the row activation', pending.text() === DRAFT, `composer text ${JSON.stringify(pending.text())} · row ${composerRow(m).trimEnd()}`)
check('esc closed the popup', await closePopup(m))
await settle(300)
check('the composer row and caret are as before the two clicks', composerRow(m) === rowBefore && (await caretAt(m, caretBefore)), `row ${composerRow(m).trimEnd()}`)

section('§4 history: a click writes nothing — neither the draft nor the command it ran')
await history.flushHistoryNow()
const afterClicks = (await history.loadHistoryCorpus()).map(record => record.display)
check('the draft never reached history', !afterClicks.some(display => display.includes('the quick brown fox')), JSON.stringify(afterClicks))
check('the clicked command never reached history either', !afterClicks.includes('/usage'), JSON.stringify(afterClicks))

section('§5 the ctrl+x p palette pick with the draft typed: an insert at the caret, never a submit')
pending.edit('')
await settle(200)
pending.edit(DRAFT)
pending.setPastedContents(PASTES)
await waitFor(() => composerRow(m).includes(DRAFT), 3000)
for (let i = 0; i < 4; i++) await press(m, KEY.left, 60)
await settle(250)
await press(m, '\x18', 120)
await press(m, 'p', 300)
check('the palette opened over the chat', m.screen().includes(PALETTE_TITLE), m.lines().filter(line => line.includes('Mercury')).join(' | '))
await press(m, 'usage', 300)
await press(m, KEY.enter, 400)
const picked = pending.text()
check('the pick inserted the command at the caret and kept every character of the draft', picked === `${DRAFT.slice(0, DRAFT.length - 4)}/usage ${DRAFT.slice(DRAFT.length - 4)}`, JSON.stringify(picked))
check('the pick ran nothing and opened no popup', usageRuns === 2 && !popup.isSettingsPopupOpen(), `runs=${usageRuns}`)
keepFrame('palette-pick-inserted-178x51', m)

section('§6 a typed submit still takes the composer and records the line')
pending.edit('')
pending.setPastedContents({})
await settle(200)
pending.edit('/usage')
await waitFor(() => composerRow(m).includes('/usage'), 3000)
await press(m, KEY.enter, 200)
const openedTyped = await waitFor(() => popup.isSettingsPopupOpen(), 5000)
await settle(300)
check('the typed /usage opened the popup and ran once', openedTyped && usageRuns === 3, `open=${openedTyped} runs=${usageRuns}`)
check('the typed line left the composer', pending.text() === '', JSON.stringify(pending.text()))
check('esc closed the popup', await closePopup(m))
await history.flushHistoryNow()
const afterTyped = (await history.loadHistoryCorpus()).map(record => record.display)
check('the typed line is in history, once, and the draft still is not', afterTyped.filter(display => display === '/usage').length === 1 && !afterTyped.some(display => display.includes('the quick brown fox')), JSON.stringify(afterTyped))

section('§7 the seam in source: the composer is taken only when it holds the submitted line (or nothing)')
{
  const { readFileSync } = await import('node:fs')
  const repl = readFileSync(join(import.meta.dir, '..', '..', 'src', 'screens', 'REPL.tsx'), 'utf8')
  const takeAt = repl.indexOf('const takeComposer = (): void => {')
  const take = takeAt < 0 ? '' : repl.slice(takeAt, repl.indexOf('};', takeAt) + 2)
  check('takeComposer reads the composer line once', take.includes("const composerLine = pendingInput.text().replace(/\\s+$/, '');"))
  check('the durable draft is cleared for the submitted line only', take.includes('if (composerLine === input) pendingInput.clearForSubmit(input);'))
  check('the live draft, its pastes, selection, buffer, caret and mode are taken only for that line or an empty composer', /if \(composerLine === '' \|\| composerLine === input\) \{\s*setInputValue\(''\);\s*setPastedContents\(\{\}\);\s*setIdeSelection\(undefined\);\s*helpers\.clearBuffer\(\);\s*helpers\.setCursorOffset\(0\);\s*setInputMode\('prompt'\);\s*\}/.test(take), take)
  check('a dispatched line still writes no history and a typed one still does', take.includes("if (!options?.fromKeybinding && !options?.rearmed) addToHistory({ display: seatMode === 'bash' ? `!${input}` : input, pastedContents: seatPastes });"))
}

m.unmount()
if (frameDir !== undefined) console.log(`\nframes: ${frames.join(', ')} under ${frameDir}`)
if (failures === 0) rmSync(HOME, { recursive: true, force: true })
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? 'prove-composer-draft-survives-dispatch: ALL PASS' : `prove-composer-draft-survives-dispatch: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
