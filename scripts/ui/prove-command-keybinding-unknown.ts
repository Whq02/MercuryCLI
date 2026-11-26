#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('command-keybinding-unknown')
for (const name of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_SKIP_PROMPT_HISTORY', 'MERCURY_MODEL']) delete process.env[name]
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_JEV_BASE: 'http://127.0.0.1:1',
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_OPERATOR: 'sam', BROWSER: '/usr/bin/true',
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
})
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
writeFileSync(
  join(HOME, 'keybindings.json'),
  JSON.stringify({
    bindings: [
      {
        context: 'Chat',
        bindings: {
          'ctrl+x s': 'command:saturn',
          'ctrl+x t': 'command:tmp',
          'ctrl+x f': 'command:foo/bar',
          'ctrl+x z': 'command:',
          'ctrl+x h': 'command:help',
        },
      },
    ],
  }),
)
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 120
const ROWS = 40
const PLACEHOLDER = 'Type a prompt'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const React = await import('react')
const { setIsInteractive } = await import('../../src/boot/process-state/processState.js')
setIsInteractive(true)
const { App } = await import('../../src/boot/App.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/screen/routes/SurfaceRouter.js')
const { Chat } = await import('../../src/screen/chat/Chat.js')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/screen/composer/input-core/pending-input.js')
const slot = await import('../../src/engine/connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands/catalogue/commands.js')
const { unknownCommandLine } = await import('../../src/engine/user-input/processSlashCommand.js')
const { markDaemonHaltStanddown } = await import('../../src/daemon/control/daemonStanddown.js')
markDaemonHaltStanddown()

const commands = await getCommands(PROJECT)
type Message = import('../../src/engine/message-shapes/message.js').Message
type SendRecord = { text: string; mode: string | undefined; fromKeybinding: boolean | undefined }
const sends: SendRecord[] = []
let displayRows: readonly Message[] = []
const listeners = new Set<() => void>()

const recording = Object.assign(new NoSessionConnector(), {
  sessionId: () => 'proof-keybinding-unknown',
  records: () => displayRows,
  subscribeRecords: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  addDisplayRow: (row: Message) => {
    displayRows = [...displayRows, row]
    for (const listener of listeners) listener()
  },
  sendWords: async (text: string, opts?: { mode?: string; fromKeybinding?: boolean }) => {
    sends.push({ text, mode: opts?.mode, fromKeybinding: opts?.fromKeybinding })
    return { state: 'accepted' as const }
  },
})

const composerRow = (m: Mounted): string => m.lines().find(line => line.startsWith('│❯') || line.startsWith('│!')) ?? '(no composer row)'
const pressChord = async (m: Mounted, key: string): Promise<void> => {
  m.push('\x18')
  await settle(100)
  m.push(key)
  await settle(250)
}

initializeSurfaceRoute(ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})
slot.setFocusedSessionConnector(recording)
const h = React.createElement
const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] })) }), COLS, ROWS)
await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
await settle(250)

try {
  const expectedSaturn = unknownCommandLine('saturn', commands)
  await pressChord(m, 's')
  const saturnPainted = await waitFor(() => m.screen().includes('Unknown command: /saturn'), 1500)
  check(
    'command:saturn keybinding paints the typed unknown-command answer with 0 sends',
    saturnPainted && displayRows.some(r => JSON.stringify(r).includes(expectedSaturn)) && sends.length === 0,
    `painted=${saturnPainted} rows=${displayRows.length} sends=${JSON.stringify(sends)}`,
  )

  const expectedTmp = unknownCommandLine('tmp', commands)
  await pressChord(m, 't')
  const tmpPainted = await waitFor(() => m.screen().includes('Unknown command: /tmp'), 1500)
  check(
    'command:tmp keybinding (existing root path) paints Unknown command with 0 sends',
    tmpPainted && displayRows.some(r => JSON.stringify(r).includes(expectedTmp)) && sends.length === 0,
    `painted=${tmpPainted} rows=${displayRows.length} sends=${JSON.stringify(sends)}`,
  )

  await pressChord(m, 'f')
  const slashPainted = await waitFor(() => m.screen().includes('Unknown command: /foo/bar'), 1500)
  check(
    'command:foo/bar keybinding (malformed) paints Unknown command with 0 sends',
    slashPainted && sends.length === 0,
    `painted=${slashPainted} rows=${displayRows.length} sends=${JSON.stringify(sends)}`,
  )

  const rowsBeforeEmpty = displayRows.length
  await pressChord(m, 'z')
  const emptyPainted = await waitFor(() => displayRows.length > rowsBeforeEmpty, 1500)
  const emptyRowText = displayRows.slice(rowsBeforeEmpty).map(r => JSON.stringify(r)).join('\n')
  check(
    'command: (empty name) paints Unknown command: / without a bogus closest suggestion and makes 0 sends',
    emptyPainted && emptyRowText.includes('Unknown command: / · /help lists commands') && !emptyRowText.includes('closest:') && sends.length === 0,
    `painted=${emptyPainted} row=${emptyRowText.slice(0, 260)} sends=${JSON.stringify(sends)}`,
  )

  for (const ch of '!ls') {
    m.push(ch)
    await settle(60)
  }
  await waitFor(() => pending.mode() === 'bash', 2000)
  await settle(150)
  const rowsBeforeBash = displayRows.length
  await pressChord(m, 's')
  const bashSaturnPainted = await waitFor(() => displayRows.length > rowsBeforeBash, 1500)
  check(
    'command:saturn pressed while composer is in bash mode paints Unknown command with 0 sends and leaves bash mode intact',
    bashSaturnPainted && pending.mode() === 'bash' && sends.length === 0,
    `painted=${bashSaturnPainted} mode=${pending.mode()} sends=${JSON.stringify(sends)}`,
  )

  m.push('\x15')
  await waitFor(() => pending.mode() === 'prompt' && pending.text() === '', 2000)
  await settle(150)
  await pressChord(m, 'h')
  const helpOpened = await waitFor(() => m.screen().includes('Commands') || m.screen().includes('Shortcuts') || m.screen().includes('general'), 3000)
  check(
    'valid command:help keybinding still opens the help dialog with 0 sends',
    helpOpened && sends.length === 0,
    `helpOpened=${helpOpened} sends=${JSON.stringify(sends)}`,
  )
} finally {
  m.unmount()
  await releaseScratchHome(HOME)
}

console.log(`prove-command-keybinding-unknown: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
