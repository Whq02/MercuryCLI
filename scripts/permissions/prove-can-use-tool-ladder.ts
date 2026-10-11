#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'can-use-tool-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'can-use-tool-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { default: useCanUseTool } = await import('../../src/hooks/useCanUseTool.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { REJECT_MESSAGE } = await import('../../src/utils/messages.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
type CanUseTool = ReturnType<typeof useCanUseTool>
type Entry = { description: string; permissionResult: unknown; input: unknown; onAllow: (input: unknown, updates: unknown[]) => Promise<void>; onAbort: () => void; onReject: (feedback?: string) => void }

const queue: Entry[] = []
const contexts: unknown[] = []
const setQueue = (updater: (prev: Entry[]) => Entry[]): void => { queue.splice(0, queue.length, ...updater([...queue])) }
const setContext = (next: unknown): void => { contexts.push(next) }

let latest: CanUseTool | null = null
function Probe(): React.ReactNode {
  latest = useCanUseTool(setQueue as never, setContext as never)
  return null
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const store = createStore(getDefaultAppState())
const emitter = new EventEmitter()
const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
const stream = new PassThrough()
stream.resume()
const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
const instance = await render(
  React.createElement(StdinContext.Provider, { value: stdinValue as never }, React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, null, React.createElement(Probe)))),
  { stdin, stdout, patchConsole: false, exitOnCtrlC: false },
)
await settle()
const canUseTool = latest as CanUseTool

let describes = 0
let describeFault: Error | null = null
const tool = {
  name: 'Probe',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async description() {
    describes++
    if (describeFault) throw describeFault
    return 'probe description'
  },
}
const assistantMessage = { type: 'assistant', uuid: 'u1', message: { id: 'msg_probe', role: 'assistant', content: [] } }
const useContext = (overrides: { aborted?: boolean; awaitChecks?: boolean } = {}) => {
  const abortController = new AbortController()
  if (overrides.aborted) abortController.abort()
  const permission = { ...getEmptyToolPermissionContext(), awaitAutomatedChecksBeforeDialog: overrides.awaitChecks === true }
  return {
    abortController,
    getAppState: () => ({ toolPermissionContext: permission }),
    setAppState() {},
    options: { isNonInteractiveSession: false, tools: [] },
    messages: [],
  }
}
const input = { command: 'echo hi' }
const ask = (context: ReturnType<typeof useContext>, forced?: unknown) => canUseTool(tool as never, input, context as never, assistantMessage as never, 'toolu_probe', forced as never)

section('§1 A FORCED ALLOW — settles at once with the allow over the updated input; no description is read')
{
  const decision = await ask(useContext(), { behavior: 'allow', updatedInput: { command: 'echo hi', refined: true }, decisionReason: { type: 'mode', mode: 'plan' } })
  check('the allow carries the updated input', decision.behavior === 'allow' && j((decision as { updatedInput?: unknown }).updatedInput) === j({ command: 'echo hi', refined: true }), j(decision))
  check('no description was read and nothing was queued', describes === 0 && queue.length === 0)
  const plain = await ask(useContext(), { behavior: 'allow' })
  check('an allow without an updated input carries the original', j((plain as { updatedInput?: unknown }).updatedInput) === j(input), j(plain))
}

section('§2 A WITHDRAWN REQUEST — an aborted signal at entry settles with the cancel decision before any work')
{
  const decision = await ask(useContext({ aborted: true }), { behavior: 'allow' })
  check('the cancel decision is an ask carrying the rejection words', decision.behavior === 'ask' && decision.message === REJECT_MESSAGE, j(decision))
  check('nothing was described or queued', describes === 0 && queue.length === 0)
}

section('§3 A FORCED DENY — the description is read first, then the deny settles as given')
{
  const forced = { behavior: 'deny', message: 'the rule says no' }
  const decision = await ask(useContext(), forced)
  check('the deny settles by identity', decision === forced, j(decision))
  check('the description was read once on the way (the tool describes before any non-allow settles)', describes === 1, String(describes))
  check('nothing was queued', queue.length === 0)
}

section('§4 AN ASK — the interactive handler queues one entry; the entry settles the promise')
{
  describes = 0
  const forced = { behavior: 'ask', message: 'Permission to use Probe requires confirmation.' }
  const pending = ask(useContext(), forced)
  await settle()
  check('one entry is queued with the description and the decision', queue.length === 1 && queue[0]?.description === 'probe description' && queue[0]?.permissionResult === forced && j(queue[0]?.input) === j(input), j(queue.map(entry => entry.description)))
  await queue[0]?.onAllow({ command: 'echo hi' }, [])
  const decision = await pending
  check('the user allow settles the promise as an allow', decision.behavior === 'allow', j(decision))
  check('the entry stays queued for the dialog to dismiss', queue.length === 1)
  queue.length = 0
  const second = ask(useContext(), forced)
  await settle()
  queue[0]?.onAbort()
  const aborted = await second
  check('an abort from the dialog settles with the cancel decision and empties the queue', aborted.behavior === 'ask' && aborted.message === REJECT_MESSAGE && queue.length === 0, j(aborted))
  const third = ask(useContext(), forced)
  await settle()
  queue[0]?.onReject('use the fixture')
  const rejected = await third
  check('a reject with words settles with the words', rejected.behavior === 'ask' && typeof rejected.message === 'string' && rejected.message.endsWith('use the fixture'), j(rejected))
  queue.length = 0
}

section('§5 AUTOMATED CHECKS FIRST — with no hook decision the dialog still follows; a withdrawn request after the checks cancels')
{
  const forced = { behavior: 'ask', message: 'Permission to use Probe requires confirmation.' }
  const context = useContext({ awaitChecks: true })
  const pending = ask(context, forced)
  await settle()
  check('with no hook ruling the ask reaches the queue', queue.length === 1, String(queue.length))
  queue[0]?.onAbort()
  await pending
  check('the queue is empty again', queue.length === 0)
}

section('§5b A WITHDRAWAL DURING THE DESCRIPTION — the description is still read; the deny never settles; the cancel decision does')
{
  describes = 0
  const context = useContext()
  const describing = { ...tool, async description() { describes++; context.abortController.abort(); return 'late' } }
  const decision = await canUseTool(describing as never, input, context as never, assistantMessage as never, 'toolu_late', { behavior: 'deny', message: 'no' } as never)
  check('a deny withdrawn while the tool describes settles with the cancel decision, after one description read', decision.behavior === 'ask' && decision.message === REJECT_MESSAGE && describes === 1, j([decision, describes]))
  describes = 0
  const allowed = useContext()
  const allowDecision = await canUseTool(describing as never, input, allowed as never, assistantMessage as never, 'toolu_allow', { behavior: 'allow' } as never)
  check('an allow never reads the description, so a withdrawal there cannot touch it', allowDecision.behavior === 'allow' && describes === 0, j([allowDecision, describes]))
}

section('§6 A FAULT ON THE ROAD — a throwing description settles with the cancel decision instead of rejecting')
{
  describeFault = new Error('the describer broke')
  const decision = await ask(useContext(), { behavior: 'deny', message: 'no' }).catch(error => ({ rejected: String(error) }))
  check('the promise settles (never rejects) with the cancel decision', 'behavior' in decision && decision.behavior === 'ask' && decision.message === REJECT_MESSAGE, j(decision))
  describeFault = Object.assign(new Error('withdrawn'), { name: 'AbortError' })
  const quiet = await ask(useContext(), { behavior: 'deny', message: 'no' })
  check('an AbortError on the road settles the same way', quiet.behavior === 'ask' && quiet.message === REJECT_MESSAGE, j(quiet))
  describeFault = null
}

instance.unmount()
instance.cleanup()
stream.destroy()
console.log(failures === 0 ? '\nPASS can-use-tool ladder' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
