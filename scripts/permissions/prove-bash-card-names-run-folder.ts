#!/usr/bin/env bun

import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'card-folder-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined, useKeybindings: () => undefined }))

const { BashPermissionRequest } = await import('../../src/components/permissions/BashPermissionRequest/BashPermissionRequest.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { setFocusedSessionConnector, emitFocusedSessionConnectorChanged, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const StdinContext = (await import('../../src/ink/components/StdinContext.js')).default
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
const { toTildePath } = await import('../../src/utils/path.js')

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'hunt-shell-')))
const SCRATCH_DIR = join(PROJECT, 'scratch-dir')
mkdirSync(SCRATCH_DIR, { recursive: true })

const facts = { cwd: PROJECT, originalCwd: PROJECT, projectRoot: PROJECT }
const resting = noSessionConnector()
const hosted = new Proxy(resting, {
  get(target, key, receiver) {
    if (key === 'workspace') return () => ({ ...facts })
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
setFocusedSessionConnector(hosted as never)

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

const toolUseContext = { abortController: new AbortController(), getAppState: () => getDefaultAppState(), setAppState: () => {}, messages: [], options: {} }
const toolUseConfirm = {
  assistantMessage: { message: { id: 'msg_card' } },
  tool: BashTool,
  description: 'Show environment variables containing MERCURY',
  input: { command: 'env | grep MERCURY', description: 'Show environment variables containing MERCURY' },
  toolUseContext,
  toolUseID: 'toolu_card_folder',
  permissionResult: { behavior: 'ask', message: 'One part of this Bash command needs approval: env' },
  permissionPromptStartTimeMs: 0,
  onUserInteraction() {},
  onAbort() {},
  onAllow() {},
  onReject() {},
  recheckPermission: async () => {},
}

async function mount(columns = 140): Promise<{ frame: () => string; settle: () => Promise<void>; close: () => void }> {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 40 }) as unknown as NodeJS.WriteStream
  const store = createStore({ ...getDefaultAppState() })
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(BashPermissionRequest, { toolUseConfirm: toolUseConfirm as never, toolUseContext: toolUseContext as never, onDone() {}, onReject() {}, verbose: false, workerBadge: undefined })
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns, rows: 40 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: columns }, node)),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame() ?? '').split('\n').map(line => line.trimEnd()).join('\n'),
    settle,
    close: () => { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

const folderLine = (frame: string): string => frame.split("\n").map(line => line.replace(/^[│\s]+/, "").replace(/[│\s]+$/, "")).find(line => /^in (?:\/|~\/|[A-Za-z]:\\)/.test(line)) ?? "(no folder line)"

try {
  section('§1 SH-08 · the session has moved into a subfolder (a cd): the card names the folder the command runs in, not the boot folder')
  facts.cwd = SCRATCH_DIR
  const card = await mount()
  const frame = card.frame()
  check('the Bash card mounted with its question', frame.includes('Bash command') && frame.includes('Do you want to proceed'), frame.slice(0, 300))
  check('the card carries a folder line', folderLine(frame) !== '(no folder line)', frame)
  check('the folder line names the subfolder the command runs in', folderLine(frame) === `in ${toTildePath(SCRATCH_DIR)}`, folderLine(frame))
  check('the folder line never names the boot folder alone', folderLine(frame) !== `in ${toTildePath(PROJECT)}`, folderLine(frame))

  section('§2 the ground moves while the card is up — the line follows the session folder')
  facts.cwd = PROJECT
  emitFocusedSessionConnectorChanged()
  await card.settle()
  check('back at the project root the line reads the root', folderLine(card.frame()) === `in ${toTildePath(PROJECT)}`, folderLine(card.frame()))
  facts.cwd = SCRATCH_DIR
  emitFocusedSessionConnectorChanged()
  await card.settle()
  check('into the subfolder again the line follows', folderLine(card.frame()) === `in ${toTildePath(SCRATCH_DIR)}`, folderLine(card.frame()))
  card.close()

  section('§3 control: a session that never moved names its boot folder (cwd and originalCwd agree)')
  facts.cwd = PROJECT
  const still = await mount()
  check('the unmoved session names the project folder', folderLine(still.frame()) === `in ${toTildePath(PROJECT)}`, folderLine(still.frame()))
  still.close()

  for (const cwd of [SCRATCH_DIR, 'scratch-dir']) {
    toolUseConfirm.input = { ...toolUseConfirm.input, cwd } as typeof toolUseConfirm.input
    const perCall = await mount()
    check('a per-call cwd names the run folder without moving the session', folderLine(perCall.frame()) === `in ${toTildePath(SCRATCH_DIR)}` && facts.cwd === PROJECT, perCall.frame())
    perCall.close()
  }
} finally {
  _resetFocusedSessionConnectorForTesting()
  rmSync(PROJECT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅ bash-card-names-run-folder PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
