#!/usr/bin/env bun

import { mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

const SCRATCH = process.env.SED_CARD_PROOF_SCRATCH ?? realpathSync(mkdtempSync(join(tmpdir(), 'sed-card-one-path-')))
const HOME = join(SCRATCH, 'home')
if (process.env.SED_CARD_PROOF_SCRATCH === undefined) {
  mkdirSync(HOME)
  const child = spawnSync(process.execPath, [import.meta.path], {
    stdio: 'inherit',
    env: { ...process.env, HOME, USERPROFILE: HOME, SED_CARD_PROOF_SCRATCH: SCRATCH },
  })
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
if (homedir() !== HOME) {
  console.log(`  [FAIL] the child's home is the scratch home — ${homedir()}`)
  process.exit(1)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type SelectProps = { onChange: (value: string) => void }
let selectProps: SelectProps | null = null
async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
let cycleMode: (() => void) | undefined
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: (action: string, handler: () => void) => { if (action === 'confirm:cycleMode') cycleMode = handler }, useKeybindings: () => undefined }))
await stub('../../src/components/CustomSelect/select.js', () => ({
  Select: (props: SelectProps) => {
    selectProps = props
    return null
  },
}))

const { BashPermissionRequest } = await import('../../src/components/permissions/BashPermissionRequest/BashPermissionRequest.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { parseForSecurity } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const { setCwd, getShellCwd } = await import('../../src/utils/Shell.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const StdinContext = (await import('../../src/ink/components/StdinContext.js')).default
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

const PROJECT = join(SCRATCH, 'project')
const SHELL_CWD = join(PROJECT, 'packages', 'foo')
mkdirSync(SHELL_CWD, { recursive: true })
const facts = { cwd: SHELL_CWD, originalCwd: PROJECT, projectRoot: PROJECT }
const resting = noSessionConnector()
const hosted = new Proxy(resting, {
  get(target, key, receiver) {
    if (key === 'workspace') return () => ({ ...facts })
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
setFocusedSessionConnector(hosted as never)
setCwd(SHELL_CWD)

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

type Approved = { command: string; _simulatedSedEdit?: { filePath: string; newContent: string } }
const toolUseContext = {
  abortController: new AbortController(),
  getAppState: () => getDefaultAppState(),
  setAppState: () => {},
  messages: [],
  options: {},
  readFileState: new Map(),
  userModified: false,
  updateFileHistoryState: () => {},
  dynamicSkillDirTriggers: new Set(),
  nestedMemoryAttachmentTriggers: new Set(),
}

async function approveCard(command: string, beforeApprove?: () => void): Promise<{ frame: string; approved: Approved | null }> {
  let approved: Approved | null = null
  selectProps = null
  await parseForSecurity(command)
  const readFile = fs.readFile
  let releaseRead = (): void => {}
  const waiting = new Promise<void>(resolve => { releaseRead = resolve })
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    await waiting
    return readFile(...args)
  }) as typeof fs.readFile
  const toolUseConfirm = {
    assistantMessage: { message: { id: 'msg_sed' } },
    tool: BashTool,
    description: 'sed edit',
    input: { command },
    toolUseContext,
    toolUseID: 'toolu_sed_one_path',
    permissionResult: { behavior: 'ask', message: 'Bash needs approval: sed' },
    permissionPromptStartTimeMs: 0,
    cwd: SHELL_CWD,
    onUserInteraction() {},
    onAbort() {},
    onAllow(updated: Approved) {
      approved = updated
    },
    onReject() {},
    recheckPermission: async () => {},
  }
  const columns = 120
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 40 }) as unknown as NodeJS.WriteStream
  const store = createStore({ ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext() })
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
  selectProps?.onChange('accept-once')
  check('Enter cannot approve before the file has loaded', approved === null)
  selectProps?.onChange('accept-session')
  check('the session choice cannot approve before the file has loaded', approved === null)
  cycleMode?.()
  check('the mode-cycle chord cannot approve before the file has loaded', approved === null)
  fs.readFile = readFile
  releaseRead()
  await settle()
  const frame = stripAnsi(instance.lastFrame() ?? '').split('\n').map(line => line.trimEnd()).join('\n')
  beforeApprove?.()
  selectProps?.onChange('accept-once')
  await settle()
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return { frame, approved }
}

try {
  check('the shell cwd differs from the process cwd', getShellCwd() === SHELL_CWD && process.cwd() !== SHELL_CWD, `shell ${getShellCwd()} · process ${process.cwd()}`)

  section('§1 a ~/ operand: the card previews the home file and the approved write lands on it')
  const homeFile = join(HOME, 'notes.txt')
  writeFileSync(homeFile, 'alpha beta\nsecond line\n')
  const tilde = await approveCard("sed -i 's/beta/gamma/' ~/notes.txt")
  check('the card shows the file as it is, not "does not exist"', tilde.frame.includes('alpha beta') && tilde.frame.includes('alpha gamma') && !tilde.frame.includes('does not exist'), tilde.frame)
  check('the approved input names the home file by its absolute path', tilde.approved?._simulatedSedEdit?.filePath === homeFile, JSON.stringify(tilde.approved))
  check('the approved content is the substituted file, not an empty one', tilde.approved?._simulatedSedEdit?.newContent === 'alpha gamma\nsecond line\n', JSON.stringify(tilde.approved))
  const tildeWrite = await BashTool.call(tilde.approved as never, toolUseContext as never)
  check('the write reports no error', (tildeWrite.data as { stderr: string }).stderr === '', JSON.stringify(tildeWrite.data))
  check('the file the card showed is the file written', readFileSync(homeFile, 'utf8') === 'alpha gamma\nsecond line\n', readFileSync(homeFile, 'utf8'))

  section('§2 a relative operand after a cd: the card previews the shell-cwd file, never the process-cwd one')
  writeFileSync(join(PROJECT, 'package.json'), 'root a\n')
  writeFileSync(join(SHELL_CWD, 'package.json'), 'foo a\n')
  const relativeRun = await approveCard("sed -i 's/a/b/' package.json")
  check('the card shows the shell-cwd file', relativeRun.frame.includes('foo a') && relativeRun.frame.includes('foo b') && !relativeRun.frame.includes('root a'), relativeRun.frame)
  check('the approved input names the shell-cwd file', relativeRun.approved?._simulatedSedEdit?.filePath === join(SHELL_CWD, 'package.json'), JSON.stringify(relativeRun.approved))
  await BashTool.call(relativeRun.approved as never, toolUseContext as never)
  check('the shell-cwd file is written and the root file is untouched', readFileSync(join(SHELL_CWD, 'package.json'), 'utf8') === 'foo b\n' && readFileSync(join(PROJECT, 'package.json'), 'utf8') === 'root a\n')
  section('§3 a change while the card is open refuses without overwriting it')
  const target = join(SHELL_CWD, 'notes.txt')
  const { FILE_UNEXPECTEDLY_MODIFIED_ERROR } = await import('../../src/tools/FileEditTool/constants.js')
  for (const changed of ['another session\n', 'alpha\r\n']) {
    writeFileSync(target, 'alpha\n')
    const stale = await approveCard("sed -i 's/alpha/beta/' notes.txt", () => writeFileSync(target, changed))
    check('the open card shows the original preview', stale.frame.includes('alpha') && stale.frame.includes('beta'), stale.frame)
    const result = await BashTool.call(stale.approved as never, toolUseContext as never)
    check('drift returns the existing Edit refusal', (result.data as { stderr: string }).stderr.startsWith(FILE_UNEXPECTEDLY_MODIFIED_ERROR), JSON.stringify(result.data))
    check('the changed file remains byte-identical', readFileSync(target, 'utf8') === changed)
  }
  writeFileSync(target, 'alpha\r\n')
  const crlf = await approveCard("sed -i 's/alpha/beta/' notes.txt")
  const crlfWrite = await BashTool.call(crlf.approved as never, toolUseContext as never)
  check('unchanged CRLF bytes still write as previewed', (crlfWrite.data as { stderr: string }).stderr === '' && readFileSync(target, 'utf8') === 'beta\r\n', JSON.stringify(crlfWrite.data))
} finally {
  _resetFocusedSessionConnectorForTesting()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅ sed-card-one-path PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
