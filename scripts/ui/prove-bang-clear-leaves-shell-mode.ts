#!/usr/bin/env bun
// gate-watch: src/components/PromptInput/PromptInput.tsx src/components/PromptInput/useComposerRawKeys.ts src/hooks/useTextInput.ts src/input-core/pending-input.ts
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('bang-clear')
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
const PLACEHOLDER = 'Type a prompt'
const CTRL_U = '\x15'
const CTRL_W = '\x17'
const BACKSPACE = '\x7f'

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
const { Chat } = await import('../../src/screens/Chat.js')
const route = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const popup = await import('../../src/utils/cockpit/commandPopup.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)

slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => 'bang-clear-session' }))
route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})

const h = React.createElement
const composerRow = (m: Mounted): string => {
  const rows = m.lines().filter(line => /^│[❯!] /.test(line))
  return rows[rows.length - 1] ?? '(no composer row)'
}
const glyph = (m: Mounted): string => composerRow(m).charAt(1)
const state = (m: Mounted): string => `mode ${pending.mode()} · text ${JSON.stringify(pending.text())} · row ${composerRow(m).trimEnd()}`
async function press(m: Mounted, data: string, ms = 160): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function typeWords(m: Mounted, words: string): Promise<void> {
  for (const ch of words) await press(m, ch, 45)
  await settle(200)
}
async function reset(m: Mounted): Promise<void> {
  pending.edit('')
  pending.setMode('prompt')
  await settle(200)
  await waitFor(() => composerRow(m).includes(PLACEHOLDER), 3000)
}

section('§0 the real chat at 178x51, the composer in prompt mode')
const m = await mountOffscreen(
  h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))),
  COLS,
  ROWS,
)
await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
await settle(300)
check('the composer painted its empty prompt row behind the ❯ glyph', composerRow(m).includes(PLACEHOLDER) && glyph(m) === '❯', state(m))

section('§1 F37A-1D-84: "!ls", ctrl+U, "/health" ↵ — the health popup opens, no shell row')
{
  await typeWords(m, '!ls')
  check('typing "!ls" opens shell mode: the text is "ls" behind the ! glyph', pending.mode() === 'bash' && pending.text() === 'ls' && glyph(m) === '!', state(m))
  await press(m, CTRL_U, 300)
  check('ONE ctrl+U empties the line AND leaves shell mode (RED before: the text went, the mode stayed)', pending.mode() === 'prompt' && pending.text() === '', state(m))
  check('the composer paints the ❯ glyph and the prompt placeholder again, never the ! placeholder', glyph(m) === '❯' && composerRow(m).includes(PLACEHOLDER), state(m))
  await typeWords(m, '/health')
  check('"/health" is typed as a slash command in prompt mode', pending.mode() === 'prompt' && pending.text() === '/health' && glyph(m) === '❯', state(m))
  await press(m, KEY.enter, 600)
  const opened = await waitFor(() => popup.commandPopupClaim()?.shape.view === 'health', 6000)
  await settle(400)
  check('↵ opened the health popup in the command-popup slot', opened, String(popup.commandPopupClaim()?.shape.view))
  const screen = m.screen()
  check('no shell row ran: neither "! /health" nor an exit code is on the screen', !screen.includes('! /health') && !screen.includes('Exited with code') && !screen.includes('exit 127'), m.lines().filter(line => /\/health|exit/i.test(line)).join(' | '))
  await press(m, KEY.esc, 300)
  await waitFor(() => popup.commandPopupClaim() === null, 4000)
  check('esc closed the popup; the composer is empty, in prompt mode', popup.commandPopupClaim() === null && pending.text() === '' && pending.mode() === 'prompt', state(m))
}

section('§2 two ctrl+U presses in one tick (the drive\'s pacing) — shell mode is gone after the first, the second is a no-op')
{
  await reset(m)
  await typeWords(m, '!git status')
  m.push(CTRL_U)
  m.push(CTRL_U)
  await settle(400)
  check('after the double press the composer is empty and in prompt mode', pending.mode() === 'prompt' && pending.text() === '' && glyph(m) === '❯', state(m))
}

section('§3 the other clears that empty the composer leave shell mode too')
{
  await reset(m)
  await typeWords(m, '!ls')
  await press(m, CTRL_W, 300)
  check('ctrl+W killing the last word of a shell line leaves prompt mode', pending.mode() === 'prompt' && pending.text() === '' && glyph(m) === '❯', state(m))
  await reset(m)
  await typeWords(m, '!echo hi')
  await press(m, KEY.esc, 120)
  await press(m, KEY.esc, 400)
  check('the esc-esc clear of a shell line leaves prompt mode with the text gone', pending.mode() === 'prompt' && pending.text() === '', state(m))
  await reset(m)
  await typeWords(m, '!')
  check('a lone "!" is shell mode with nothing typed yet', pending.mode() === 'bash' && pending.text() === '' && glyph(m) === '!', state(m))
  await press(m, KEY.esc, 300)
  check('esc right after "!" returns to prompt mode', pending.mode() === 'prompt' && glyph(m) === '❯', state(m))
}

section('§4 the law\'s edge: backspace is not a clear — the ! stays until the operator deletes it too')
{
  await reset(m)
  await typeWords(m, '!ls')
  await press(m, BACKSPACE, 150)
  await press(m, BACKSPACE, 300)
  check('two backspaces empty the text and keep shell mode (the ! was typed, it is still there)', pending.mode() === 'bash' && pending.text() === '' && glyph(m) === '!', state(m))
  await press(m, BACKSPACE, 300)
  check('a third backspace deletes the ! itself: prompt mode', pending.mode() === 'prompt' && glyph(m) === '❯', state(m))
}

section('§5 a shell line that keeps text keeps its mode')
{
  await reset(m)
  await typeWords(m, '!ls -la')
  await press(m, CTRL_W, 300)
  check('ctrl+W that leaves text behind keeps shell mode (the word law is the cursor\'s: "ls -" stays)', pending.mode() === 'bash' && pending.text() !== '' && glyph(m) === '!', state(m))
  await press(m, CTRL_U, 300)
  check('…and the ctrl+U that empties it leaves prompt mode', pending.mode() === 'prompt' && pending.text() === '', state(m))
}

m.unmount()
if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? 'prove-bang-clear-leaves-shell-mode: ALL PASS' : `prove-bang-clear-leaves-shell-mode: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
