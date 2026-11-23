#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { getEventListeners } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CancellationToken } from 'vscode-jsonrpc'
import { removeScratch } from '../lib/removeScratch.ts'

const home = mkdtempSync(path.join(tmpdir(), 'lsp-instance-recording-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS
delete process.env.MERCURY_ERROR_REPORTING

const RECORDING = path.join(import.meta.dir, 'recordings', 'lsp-instance.txt')
const RECORDING_NAME = 'scripts/lsp/recordings/lsp-instance.txt'
const SELF = 'scripts/lsp/prove-lsp-instance-recording.ts'
const WRITE = process.argv.includes('--write')
const DOOR = 'src/integrations/lsp/LSPServerInstance.ts'
const CLIENT = 'src/integrations/lsp/LSPClient.ts'
const WORKSPACE = path.join(home, 'workspace')
const CLOCK_START = 1_700_000_000_000

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realNow = Date.now

type Timer = { id: number; ms: number; at: number; run: () => void; live: boolean; fired: boolean }
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
type Script = {
  start?: () => unknown
  initialize?: () => unknown
  request?: (method: string, call: number) => unknown
  notify?: (method: string) => unknown
  stop?: () => unknown
}
type Scripted = { capabilities: unknown; isInitialized: boolean }

const lines: string[] = []
const unhandled: unknown[] = []
const replaced: string[] = []
const scripts = new Map<string, Script>()
const crashes = new Map<string, (error: Error) => void>()
const clients = new Map<string, Scripted>()
const calls = new Map<string, number>()
const NEVER = 'never settled'
let standing = 'before the first scene'
let clock = CLOCK_START
let timers: Timer[] = []
let timerSeq = 0
let failures = 0

process.on('unhandledRejection', reason => unhandled.push(reason))

const plain = (text: string): string => text.replaceAll(pathToFileURL(WORKSPACE).href, 'file://<workspace>').replaceAll(WORKSPACE, '<workspace>').replaceAll(String(process.pid), '<pid>')
const say = (text: string): void => void lines.push(plain(text))
const step = (text: string): void => void lines.push(plain(`> ${text}`))
const called = (server: string, method: string): number => calls.get(`${server}.${method}`) ?? 0
const turn = (): Promise<void> => new Promise(done => realSetTimeout(done, 0))
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const bounded = <T>(asked: Promise<T>, ms = 15_000): Promise<T | typeof NEVER> =>
  Promise.race([asked, new Promise<typeof NEVER>(done => realSetTimeout(() => done(NEVER), ms))])

async function until(test: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = realNow() + ms
  while (!test() && realNow() < deadline) await new Promise(done => realSetTimeout(done, 5))
  return test()
}

function scene(title: string): void {
  standing = title
  timers = []
  timerSeq = 0
  lines.push('', `## ${title}`)
}

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
  const timer: Timer = { id: ++timerSeq, ms, at: clock + ms, run: () => fn(...args), live: true, fired: false }
  timers.push(timer)
  say(`  timer ${timer.id} armed for ${ms}ms`)
  const handle = {
    timer,
    ref: () => handle,
    unref: () => {
      say(`  timer ${timer.id} unref`)
      return handle
    },
    hasRef: () => false,
  }
  return handle
}) as unknown as typeof setTimeout
globalThis.clearTimeout = ((handle?: { timer?: Timer }) => {
  const timer = handle?.timer
  if (timer === undefined) return void realClearTimeout(handle as never)
  say(`  timer ${timer.id} cleared${timer.live ? '' : timer.fired ? ' after it fired' : ' again'}`)
  timer.live = false
}) as unknown as typeof clearTimeout
Date.now = () => clock

async function pass(ms: number): Promise<void> {
  clock += ms
  say(`  the clock moves ${ms}ms`)
  for (const timer of [...timers]) {
    if (!timer.live || timer.at > clock) continue
    timer.live = false
    timer.fired = true
    say(`  timer ${timer.id} fires`)
    timer.run()
  }
  await turn()
}

const realClient = await import(`../../${CLIENT}`)
function scriptedClient(serverName: string, onCrash?: (error: Error) => void) {
  say(`  client created for ${serverName}`)
  crashes.set(serverName, error => onCrash?.(error))
  const script = (): Script => scripts.get(serverName) ?? {}
  const count = (method: string): number => {
    const next = called(serverName, method) + 1
    calls.set(`${serverName}.${method}`, next)
    return next
  }
  const client = {
    capabilities: undefined as unknown,
    isInitialized: false,
    async start(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<void> {
      count('start')
      say(`  client.start ${command} ${JSON.stringify(args)} env.RECORDING=${options?.env?.RECORDING ?? '-'} env.PATH ${Object.entries(options?.env ?? {}).some(([key, value]) => key.toUpperCase() === 'PATH' && value !== undefined) ? 'carried' : 'absent'} cwd=${options?.cwd ?? '-'} | ${glance(serverName)}`)
      await script().start?.()
    },
    async initialize(params: Record<string, unknown>): Promise<unknown> {
      const capabilities = params.capabilities as { workspace?: object; textDocument?: object }
      count('initialize')
      say(`  client.initialize processId=${String(params.processId)} rootPath=${String(params.rootPath)} rootUri=${String(params.rootUri)} folders=${JSON.stringify(params.workspaceFolders)} options=${JSON.stringify(params.initializationOptions)} workspace keys=${Object.keys(capabilities.workspace ?? {}).join(',')} textDocument keys=${Object.keys(capabilities.textDocument ?? {}).join(',')} | ${glance(serverName)}`)
      await script().initialize?.()
      client.capabilities = { hoverProvider: true }
      client.isInitialized = true
      return { capabilities: client.capabilities }
    },
    async sendRequest(method: string, params: unknown, token?: CancellationToken): Promise<unknown> {
      const call = count('sendRequest')
      say(`  client.sendRequest ${method} ${JSON.stringify(params)} token ${token === undefined ? 'absent' : token.isCancellationRequested ? 'cancelled' : 'live'}`)
      token?.onCancellationRequested(() => say(`  client: the token of ${method} is cancelled`))
      const answer = script().request
      return answer === undefined ? { echoed: method } : await answer(method, call)
    },
    async sendNotification(method: string, params: unknown): Promise<void> {
      say(`  client.sendNotification ${method} ${JSON.stringify(params)}`)
      await script().notify?.(method)
    },
    onNotification(method: string, handler: unknown): void {
      count('onNotification')
      say(`  client.onNotification ${method} handler ${typeof handler}`)
    },
    onRequest(method: string, handler: unknown): void {
      count('onRequest')
      say(`  client.onRequest ${method} handler ${typeof handler}`)
    },
    async stop(opts?: unknown): Promise<unknown> {
      say(`  client.stop ${JSON.stringify(opts) ?? 'undefined'} | ${glance(serverName)}`)
      const result = await script().stop?.()
      client.isInitialized = false
      client.capabilities = undefined
      return result === undefined ? { outcome: 'exited', elapsedMs: 0, exitCode: 0, survivors: [] } : result
    },
  }
  clients.set(serverName, client)
  return client
}
mock.module(`../../${CLIENT}`, () => ({ ...realClient, createLSPClient: scriptedClient }))
replaced.push(CLIENT)

const door = await import(`../../${DOOR}`)
const { runWithLspAbortSignal, lspRequestFaultCount } = await import('../../src/integrations/lsp/lspAbort.ts')
const { _setLspLedgerClockForTesting } = await import('../../src/integrations/lsp/failureLedger.ts')
const { getExecution } = await import('../../src/engine/execution-plane/executionPlane.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
const { attachErrorLogSink } = await import('../../src/platform/logs/errorLog.ts')
type Instance = ReturnType<typeof door.createLSPServerInstance>
type Config = Parameters<typeof door.createLSPServerInstance>[1]
const instances = new Map<string, Instance>()

_setLspLedgerClockForTesting(() => clock)
attachErrorLogSink({
  logError: (error: Error) => say(`  logged ${error.name}: ${error.message}`),
  logMCPError: () => undefined,
  logMCPDebug: () => undefined,
  getErrorsPath: () => '',
  getMCPLogsPath: () => '',
})

function planeOf(name: string): string {
  const record = getExecution(processMainOwner(), `language-server:${name}`)
  if (record === undefined) return 'none'
  return `${record.state}${record.outcome?.reason !== undefined ? ` (${record.outcome.reason})` : ''}`
}

function glance(name: string): string {
  return `state=${instances.get(name)?.state ?? '?'} plane=${planeOf(name)}`
}

function told(error: unknown): string {
  if (!(error instanceof Error)) return `a ${typeof error}: ${String(error)}`
  const failure = error as Error & { server?: string; attempts?: number; lspCause?: string; refused?: boolean; retryAt?: number }
  const fields =
    failure.server === undefined
      ? ''
      : ` {server=${failure.server} attempts=${failure.attempts} lspCause=${JSON.stringify(failure.lspCause)} refused=${failure.refused} retryAt=${failure.retryAt === undefined ? 'none' : `clock+${failure.retryAt - clock}`} isLspStartFailure=${door.isLspStartFailure(error)}}`
  return `${error.name}: ${error.message}${fields}`
}

function shot(name: string): void {
  const instance = instances.get(name)!
  say(
    `  state=${instance.state} healthy=${instance.isHealthy()} generation=${instance.generation} restarts=${instance.restartCount} started=${instance.startTime === undefined ? 'never' : `clock+${instance.startTime - CLOCK_START}`} lastError=${instance.lastError === undefined ? 'none' : told(instance.lastError)} capabilities=${JSON.stringify(instance.capabilities) ?? 'none'} plane=${planeOf(name)}`,
  )
}

function make(name: string, extra: Record<string, unknown> = {}): { instance: Instance; config: Config } {
  const config = {
    command: 'scripted-server',
    args: ['--stdio'],
    extensionToLanguage: { '.fake': 'fake' },
    transport: 'stdio',
    env: { RECORDING: name },
    workspaceFolder: WORKSPACE,
    scope: 'dynamic',
    source: 'instance-recording',
    ...extra,
  } as unknown as Config
  const instance = door.createLSPServerInstance(name, config)
  instances.set(name, instance)
  return { instance, config }
}

async function answerOf(call: () => Promise<unknown>): Promise<{ answer: unknown; faults: number } | { error: unknown; faults: number }> {
  try {
    return { answer: await call(), faults: lspRequestFaultCount() }
  } catch (error) {
    return { error, faults: lspRequestFaultCount() }
  }
}

async function asked(label: string, call: () => Promise<unknown>, signal?: AbortSignal, within: 'its own call' | 'the call around it' = 'its own call'): Promise<unknown> {
  const outcome = await bounded(within === 'its own call' ? runWithLspAbortSignal(signal, () => answerOf(call)) : answerOf(call))
  if (outcome === NEVER) {
    say(`  ${label} -> ${NEVER}`)
    return undefined
  }
  if ('error' in outcome) {
    say(`  ${label} -> refused ${told(outcome.error)} | faults noted ${outcome.faults}`)
    return outcome.error
  }
  say(`  ${label} -> ${JSON.stringify(outcome.answer) ?? 'undefined'} | faults noted ${outcome.faults}`)
  return outcome.answer
}

const crash = (name: string, message: string): void => {
  step(`the client reports a crash: ${message}`)
  crashes.get(name)?.(new Error(message))
}
const contentModified = (): Promise<never> => Promise.reject(Object.assign(new Error('content modified'), { code: -32801 }))

function sayDifferences(recorded: string, now: string): void {
  const was = recorded.split('\n')
  const is = now.split('\n')
  let shown = 0
  for (let index = 0; index < Math.max(was.length, is.length) && shown < 20; index++) {
    if (was[index] === is[index]) continue
    shown++
    console.log(`  line ${index + 1}\n    recorded: ${was[index] ?? '(none)'}\n    now:      ${is[index] ?? '(none)'}`)
  }
}

const recorded = existsSync(RECORDING) ? readFileSync(RECORDING, 'utf8') : ''
const watchdog = realSetTimeout(() => {
  const sofar = `${lines.join('\n').trimStart()}\n`
  sayDifferences(recorded.split('\n').slice(0, sofar.split('\n').length - 1).join('\n') + '\n', sofar)
  console.log(`  [FAIL] the scene "${standing}" did not come to its end within 120 s: a step of createLSPServerInstance it waits for never settles; the ${lines.length} lines before it are compared above with ${RECORDING_NAME}`)
  console.log('prove-lsp-instance-recording: 1 FAILURE')
  process.exit(1)
}, 120_000)

console.log('prove-lsp-instance-recording — createLSPServerInstance over a scripted client, clock and timers')
check(
  `the unit under test is the product's own createLSPServerInstance from ${DOOR}; this proof replaces one module, ${CLIENT}, and nothing of the door`,
  replaced.length === 1 && replaced[0] === CLIENT && typeof door.createLSPServerInstance === 'function' && door.createLSPServerInstance.name === 'createLSPServerInstance' && typeof door.isLspStartFailure === 'function' && Object.keys(door).sort().join(',') === 'createLSPServerInstance,isLspStartFailure',
  `replaced ${replaced.join(', ')}; the door exports ${Object.keys(door).sort().join(', ')}`,
)

try {
  scene('a new instance, before anything is asked of it')
  {
    const { instance, config } = make('fresh')
    step('its face')
    say(`  name=${instance.name} config is the object handed in=${instance.config === config}`)
    shot('fresh')
    step('a request, a notification and a stop before any start')
    await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', { line: 1 }))
    await asked('sendNotification textDocument/didOpen', () => instance.sendNotification('textDocument/didOpen', {}))
    await asked('stop', () => instance.stop())
    say(`  clients created so far=${clients.size}`)
    step('two handlers registered before any start')
    instance.onNotification('textDocument/publishDiagnostics', () => undefined)
    instance.onRequest('workspace/configuration', () => null)
    say(`  the client holds both=${await until(() => called('fresh', 'onNotification') === 1 && called('fresh', 'onRequest') === 1)}`)
    shot('fresh')
  }

  scene('a start, a request, a notification, a stop, and a second life')
  {
    const { instance } = make('steady')
    step('start')
    await asked('start', () => instance.start())
    shot('steady')
    step('start again while it runs')
    await asked('start', () => instance.start())
    step('a request and a notification')
    await asked('sendRequest textDocument/definition', () => instance.sendRequest('textDocument/definition', { line: 3 }))
    await asked('sendNotification textDocument/didChange', () => instance.sendNotification('textDocument/didChange', { version: 2 }))
    step('a handler registered while it runs')
    instance.onNotification('window/logMessage', () => undefined)
    say(`  the client holds it=${await until(() => called('steady', 'onNotification') === 1)}`)
    step('stop')
    await asked('stop', () => instance.stop())
    shot('steady')
    step('stop again while it is stopped')
    await asked('stop', () => instance.stop())
    step('the clock moves, then a second start')
    clock += 5_000
    await asked('start', () => instance.start())
    shot('steady')
    await asked('stop', () => instance.stop())
  }

  scene('a stop bounded by shutdownTimeout')
  {
    const { instance } = make('bounded-stop', { shutdownTimeout: 250 })
    await asked('start', () => instance.start())
    await asked('stop', () => instance.stop())
  }

  scene('two starts at once join, and two stops at once join')
  {
    const { instance } = make('joined')
    const gate = deferred<void>()
    scripts.set('joined', { start: () => gate.promise })
    step('two starts, the server not yet up')
    const first = asked('the first start', () => instance.start())
    const second = asked('the second start', () => instance.start())
    say(`  the client was asked to start=${await until(() => called('joined', 'start') === 1)}`)
    shot('joined')
    step('the server comes up')
    gate.resolve()
    await first
    await second
    shot('joined')
    const stopGate = deferred<unknown>()
    scripts.set('joined', { stop: () => stopGate.promise })
    step('two stops, the server not yet down')
    let firstResult: unknown
    let secondResult: unknown
    const firstStop = instance.stop().then((result: unknown) => {
      firstResult = result
    })
    const secondStop = instance.stop().then((result: unknown) => {
      secondResult = result
    })
    await turn()
    shot('joined')
    step('the server goes down')
    stopGate.resolve({ outcome: 'killed', elapsedMs: 12, exitCode: null, survivors: [] })
    await bounded(Promise.all([firstStop, secondStop]))
    say(`  the first stop answers ${JSON.stringify(firstResult)}; the second answers the same object=${firstResult !== undefined && firstResult === secondResult}`)
    shot('joined')
  }

  scene('a start that fails before the server is spawned, and the wait that grows after each failure')
  {
    const { instance } = make('unspawned')
    scripts.set('unspawned', {
      start: () => {
        throw new Error('spawn scripted-server ENOENT')
      },
    })
    step('the first failure')
    const firstFailure = await asked('start', () => instance.start())
    say(`  lastError is the failure thrown=${instance.lastError === firstFailure}`)
    shot('unspawned')
    step('a start at once, inside the wait')
    const refusal = await asked('start', () => instance.start())
    say(`  lastError is still the first failure=${instance.lastError === firstFailure} and not the refusal=${instance.lastError !== refusal}`)
    step('a start one millisecond before the wait ends')
    clock += 14_999
    await asked('start', () => instance.start())
    for (const wait of [1, 30_000, 60_000, 120_000, 240_000, 300_000]) {
      step(`a start ${wait}ms later`)
      clock += wait
      await asked('start', () => instance.start())
    }
    step('one millisecond before the longest wait ends, then at its end with the server mended')
    clock += 299_999
    await asked('start', () => instance.start())
    clock += 1
    scripts.set('unspawned', {})
    await asked('start', () => instance.start())
    shot('unspawned')
    step('after a start that held, the count of failures begins again')
    await asked('stop', () => instance.stop())
    scripts.set('unspawned', {
      start: () => {
        throw 'a bare word thrown'
      },
    })
    await asked('start', () => instance.start())
    shot('unspawned')
  }

  scene('a start that fails after the spawn: the client is stopped')
  {
    const { instance } = make('spawned')
    scripts.set('spawned', {
      initialize: () => {
        throw new Error('LSP server spawned failed to start: initialize refused')
      },
    })
    step('initialize refuses')
    await asked('start', () => instance.start())
    shot('spawned')
    step('initialize refuses and the stop after it fails too')
    clock += 15_000
    scripts.set('spawned', {
      initialize: () => {
        throw new Error('LSP server spawned crashed with exit code 3')
      },
      stop: () => {
        throw new Error('the stop failed too')
      },
    })
    await asked('start', () => instance.start())
    shot('spawned')
  }

  scene('a start bounded by startupTimeout')
  {
    const { instance } = make('slow', { startupTimeout: 4_000 })
    step('initialize answers in time')
    await asked('start', () => instance.start())
    await asked('stop', () => instance.stop())
    step('initialize never answers')
    scripts.set('slow', { initialize: () => new Promise(() => undefined) })
    const pending = asked('start', () => instance.start())
    say(`  the client was asked to initialize=${await until(() => called('slow', 'initialize') === 2)}`)
    shot('slow')
    await pass(4_000)
    await pending
    shot('slow')
  }

  scene('the rust-analyzer component is missing')
  {
    const { instance } = make('rust')
    scripts.set('rust', {
      start: () => {
        throw new Error("error: Unknown binary 'rust-analyzer' in official toolchain 'stable-aarch64-apple-darwin'.")
      },
    })
    step('two starts inside one call')
    await runWithLspAbortSignal(undefined, async () => {
      const first = await asked('the first start', () => instance.start(), undefined, 'the call around it')
      const second = await asked('the second start', () => instance.start(), undefined, 'the call around it')
      say(`  the second start throws the first failure itself=${first === second && instance.lastError === first}`)
    })
    shot('rust')
    step('a start in another call')
    await asked('start', () => instance.start())
    step('a start outside any call, twice')
    await bounded(instance.start().then(() => say('  start -> undefined'), (error: unknown) => say(`  start -> refused ${told(error)}`)))
    await bounded(instance.start().then(() => say('  start -> undefined'), (error: unknown) => say(`  start -> refused ${told(error)}`)))
    shot('rust')
    step('inside one call: a start, a second start, then a restart, which forgets the call that saw the failure')
    await runWithLspAbortSignal(undefined, async () => {
      await asked('the first start', () => instance.start(), undefined, 'the call around it')
      await asked('the second start', () => instance.start(), undefined, 'the call around it')
      await asked('restart', () => instance.restart(), undefined, 'the call around it')
    })
    shot('rust')
    step('inside one call: a failure; the server is mended, a call of its own starts and stops it; then the first call starts it again')
    await runWithLspAbortSignal(undefined, async () => {
      await asked('the first start', () => instance.start(), undefined, 'the call around it')
      scripts.set('rust', {})
      await asked('a start in a call of its own', () => instance.start())
      await asked('stop', () => instance.stop())
      await asked('the first call starts again', () => instance.start(), undefined, 'the call around it')
    })
    shot('rust')
    await asked('stop', () => instance.stop())
  }

  scene('a crash, then the component goes missing, then a crash again: the missing component began the crash count again')
  {
    const { instance } = make('rust-crash', { maxRestarts: 1 })
    await asked('start', () => instance.start())
    crash('rust-crash', 'LSP server rust-crash crashed with exit code 1')
    step('a start that finds the component missing')
    scripts.set('rust-crash', {
      start: () => {
        throw new Error("error: Unknown binary 'rust-analyzer' in official toolchain 'stable-aarch64-apple-darwin'.")
      },
    })
    await asked('start', () => instance.start())
    crash('rust-crash', 'LSP server rust-crash crashed with exit code 1')
    step('15000ms later, the server mended: one crash since the count began again, under a cap of one')
    clock += 15_000
    scripts.set('rust-crash', {})
    await asked('start', () => instance.start())
    shot('rust-crash')
    await asked('stop', () => instance.stop())
  }

  scene('a crash, and what a start does after it')
  {
    const { instance } = make('crashing')
    await asked('start', () => instance.start())
    crash('crashing', 'LSP server crashing crashed with exit code 1')
    shot('crashing')
    await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}))
    step('a start after one crash')
    await asked('start', () => instance.start())
    shot('crashing')
    step('three crashes, then a start: the start that held began the count again, so this one is within the cap')
    for (const round of [1, 2, 3]) crashes.get('crashing')?.(new Error(`LSP server crashing connection closed (${round})`))
    await asked('start', () => instance.start())
    shot('crashing')
    step('four crashes with no start between them')
    for (const round of [1, 2, 3, 4]) crashes.get('crashing')?.(new Error(`LSP server crashing connection closed (${round})`))
    shot('crashing')
    const capped = await asked('start', () => instance.start())
    say(`  lastError is the cap's error=${instance.lastError === capped}`)
    shot('crashing')
    step('restart brings a capped server back')
    await asked('restart', () => instance.restart())
    shot('crashing')
    await asked('stop', () => instance.stop())
  }

  scene('the crash cap as configured')
  {
    for (const [name, maxRestarts, rounds] of [
      ['cap-three', 3, 3],
      ['cap-one', 1, 2],
      ['cap-zero', 0, 1],
    ] as const) {
      const { instance } = make(name, { maxRestarts })
      await asked('start', () => instance.start())
      step(`maxRestarts ${maxRestarts}, ${rounds} crash(es), then a start`)
      for (let round = 0; round < rounds; round++) crashes.get(name)?.(new Error(`LSP server ${name} exited unexpectedly (code 0, signal none)`))
      await asked('start', () => instance.start())
      shot(name)
    }
  }

  scene('restartOnCrash false')
  {
    const { instance } = make('pinned', { restartOnCrash: false })
    await asked('start', () => instance.start())
    crash('pinned', 'LSP server pinned crashed with exit code 9')
    step('a start after the crash')
    const refusal = await asked('start', () => instance.start())
    say(`  lastError is the refusal thrown=${instance.lastError === refusal}`)
    step('a second start')
    await asked('start', () => instance.start())
    shot('pinned')
  }

  scene('a stop that fails')
  {
    const { instance } = make('wedged')
    await asked('start', () => instance.start())
    const wedge = new Error('shutdown wedged')
    scripts.set('wedged', {
      stop: () => {
        throw wedge
      },
    })
    step('the client throws an Error')
    const thrown = await asked('stop', () => instance.stop())
    say(`  the Error thrown is the client's own=${thrown === wedge} and is lastError=${instance.lastError === wedge}`)
    shot('wedged')
    step('a start after it, then the client throws a bare word')
    scripts.set('wedged', {})
    await asked('start', () => instance.start())
    scripts.set('wedged', {
      stop: () => {
        throw 'bare words'
      },
    })
    await asked('stop', () => instance.stop())
    shot('wedged')
  }

  scene('restart')
  {
    const { instance } = make('again')
    step('a restart of a server never started')
    await asked('restart', () => instance.restart())
    shot('again')
    step('a restart of a running server')
    const stopResult = { outcome: 'exited', elapsedMs: 7, exitCode: 0, survivors: [] }
    scripts.set('again', { stop: () => stopResult })
    const answered = await asked('restart', () => instance.restart())
    say(`  restart answers the stop's own result=${answered === stopResult}`)
    shot('again')
    step('the stop leaves survivors')
    scripts.set('again', { stop: () => ({ outcome: 'killed', elapsedMs: 9, exitCode: null, survivors: [4242, 4243] }) })
    await asked('restart', () => instance.restart())
    shot('again')
    step('the stop throws an Error, then a bare word')
    scripts.set('again', {})
    await asked('start', () => instance.start())
    scripts.set('again', {
      stop: () => {
        throw new Error('shutdown wedged')
      },
    })
    await asked('restart', () => instance.restart())
    shot('again')
    scripts.set('again', {})
    await asked('start', () => instance.start())
    scripts.set('again', {
      stop: () => {
        throw 'bare words'
      },
    })
    await asked('restart', () => instance.restart())
    step('the start after the stop fails')
    scripts.set('again', {})
    await asked('start', () => instance.start())
    scripts.set('again', {
      start: () => {
        throw new Error('spawn scripted-server EACCES')
      },
    })
    await asked('restart', () => instance.restart())
    shot('again')
    step('a restart inside the wait of that failure starts at once')
    scripts.set('again', {})
    await asked('start', () => instance.start())
    await asked('restart', () => instance.restart())
    shot('again')
  }

  scene('requests: answers, failures, and the retry of content modified')
  {
    const { instance } = make('asking', { requestTimeout: 700 })
    await asked('start', () => instance.start())
    step('the server answers null')
    scripts.set('asking', { request: () => null })
    await asked('sendRequest textDocument/documentSymbol', () => instance.sendRequest('textDocument/documentSymbol', {}))
    step('the server refuses with an Error, then with a bare word')
    scripts.set('asking', {
      request: () => {
        throw new Error('server said no')
      },
    })
    await asked('sendRequest textDocument/references', () => instance.sendRequest('textDocument/references', {}))
    scripts.set('asking', {
      request: () => {
        throw 'bare words'
      },
    })
    await asked('sendRequest textDocument/references', () => instance.sendRequest('textDocument/references', {}))
    step('content modified once, then an answer')
    scripts.set('asking', { request: (_method, call) => (call % 2 === 0 ? contentModified() : { symbols: 2 }) })
    {
      const pending = asked('sendRequest textDocument/documentSymbol', () => instance.sendRequest('textDocument/documentSymbol', {}))
      await turn()
      await pass(500)
      await pending
    }
    step('content modified every time, inside a budget of 700ms')
    scripts.set('asking', { request: () => contentModified() })
    {
      const pending = asked('sendRequest textDocument/documentSymbol', () => instance.sendRequest('textDocument/documentSymbol', {}))
      await turn()
      await pass(500)
      await pass(200)
      await pending
    }
    await asked('stop', () => instance.stop())
  }

  scene('requests: content modified every time, inside the default budget')
  {
    const { instance } = make('patient')
    await asked('start', () => instance.start())
    scripts.set('patient', { request: () => contentModified() })
    const pending = asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}))
    await turn()
    await pass(500)
    await pass(1_000)
    await pass(2_000)
    await pending
    await asked('stop', () => instance.stop())
  }

  scene('requests: the deadline, the interrupt, and a server that is not healthy')
  {
    const { instance } = make('silent', { requestTimeout: 700 })
    await asked('start', () => instance.start())
    scripts.set('silent', { request: () => new Promise(() => undefined) })
    step('no answer within the budget')
    {
      const pending = asked('sendRequest textDocument/definition', () => instance.sendRequest('textDocument/definition', {}))
      await turn()
      await pass(700)
      await pending
    }
    step('the operator interrupts a request in flight')
    {
      const controller = new AbortController()
      const pending = asked('sendRequest textDocument/references', () => instance.sendRequest('textDocument/references', {}), controller.signal)
      await turn()
      say(`  abort listeners on the signal while it waits=${getEventListeners(controller.signal, 'abort').length}`)
      controller.abort()
      await pending
      say(`  abort listeners on the signal after=${getEventListeners(controller.signal, 'abort').length}`)
    }
    step('the signal is already aborted')
    {
      const controller = new AbortController()
      controller.abort()
      await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}), controller.signal)
    }
    step('an answered request under a live signal leaves no listener')
    {
      const controller = new AbortController()
      scripts.set('silent', {})
      await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}), controller.signal)
      say(`  abort listeners on the signal after=${getEventListeners(controller.signal, 'abort').length}`)
    }
    step('the client says it is not initialized')
    clients.get('silent')!.isInitialized = false
    shot('silent')
    await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}))
    await asked('sendNotification textDocument/didSave', () => instance.sendNotification('textDocument/didSave', {}))
    clients.get('silent')!.isInitialized = true
    step('the server crashed')
    crash('silent', 'LSP server silent crashed with exit code 2')
    await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}))
    await asked('sendNotification textDocument/didSave', () => instance.sendNotification('textDocument/didSave', {}))
  }

  scene('notifications that fail')
  {
    const { instance } = make('telling')
    await asked('start', () => instance.start())
    scripts.set('telling', {
      notify: () => {
        throw new Error('the pipe is closed')
      },
    })
    await asked('sendNotification textDocument/didChange', () => instance.sendNotification('textDocument/didChange', {}))
    scripts.set('telling', {
      notify: () => {
        throw 'bare words'
      },
    })
    await asked('sendNotification textDocument/didChange', () => instance.sendNotification('textDocument/didChange', {}))
    shot('telling')
    await asked('stop', () => instance.stop())
  }

  scene('the idle limit: activity puts the stop off, quiet brings it')
  {
    const { instance } = make('idle', { idleTimeoutMs: 300 })
    await asked('start', () => instance.start())
    step('150ms pass, then a request')
    await pass(150)
    await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}))
    step('150ms more: the limit comes due 150ms after the last activity')
    await pass(150)
    shot('idle')
    step('300ms of quiet')
    await pass(300)
    say(`  the server stopped=${await until(() => instance.state === 'stopped')}`)
    shot('idle')
    step('a start after the idle stop, then a stop by hand')
    await asked('start', () => instance.start())
    await asked('stop', () => instance.stop())
    shot('idle')
    step('a start after the stop by hand, and a stop')
    await asked('start', () => instance.start())
    await asked('stop', () => instance.stop())
  }

  scene('the idle limit: a stop that fails, and a limit that comes due on a crashed server')
  {
    const { instance } = make('idle-wedged', { idleTimeoutMs: 300 })
    await asked('start', () => instance.start())
    scripts.set('idle-wedged', {
      stop: () => {
        throw new Error('shutdown wedged')
      },
    })
    step('300ms of quiet, and the stop fails')
    await pass(300)
    say(`  the server is in error=${await until(() => instance.state === 'error')}`)
    shot('idle-wedged')
    step('a start, a crash, then the limit comes due')
    scripts.set('idle-wedged', {})
    await asked('start', () => instance.start())
    crash('idle-wedged', 'LSP server idle-wedged crashed with exit code 1')
    await pass(300)
    shot('idle-wedged')
    step('a start after it arms the limit again')
    await asked('start', () => instance.start())
    step('a crash and a start before the limit comes due: the old limit is cleared and a new one armed')
    crash('idle-wedged', 'LSP server idle-wedged crashed with exit code 1')
    await asked('start', () => instance.start())
    await asked('stop', () => instance.stop())
  }

  scene('an idle limit set on the config of a running server is taken up at its next activity')
  {
    const { instance, config } = make('late-limit')
    await asked('start', () => instance.start())
    step('a request with no limit set')
    await asked('sendRequest textDocument/hover', () => instance.sendRequest('textDocument/hover', {}))
    step('the limit is set, then a notification')
    ;(config as { idleTimeoutMs?: number }).idleTimeoutMs = 300
    await asked('sendNotification textDocument/didChange', () => instance.sendNotification('textDocument/didChange', {}))
    step('300ms of quiet')
    await pass(300)
    say(`  the server stopped=${await until(() => instance.state === 'stopped')}`)
    shot('late-limit')
  }

  scene('what each call has done by the time it hands back its promise')
  {
    const { instance } = make('prompt')
    const starting = instance.start()
    say(`  start has handed back its promise: state=${instance.state} plane=${planeOf('prompt')}`)
    await bounded(starting)
    const sent = instance.sendRequest('textDocument/hover', {})
    say('  sendRequest has handed back its promise')
    await bounded(sent)
    const noted = instance.sendNotification('textDocument/didChange', {})
    say('  sendNotification has handed back its promise')
    await bounded(noted)
    const stopping = instance.stop()
    say(`  stop has handed back its promise: state=${instance.state} plane=${planeOf('prompt')}`)
    await bounded(stopping)
    const again = instance.restart()
    say(`  restart has handed back its promise: state=${instance.state}`)
    await bounded(again)
    shot('prompt')
    const down = instance.stop()
    const up = instance.start()
    say(`  a stop and then a start, neither awaited: state=${instance.state}`)
    await bounded(Promise.allSettled([down, up]))
    shot('prompt')
  }

  await turn()
  scene('the whole run')
  say(`  unhandled rejections=${unhandled.length}`)
  say(`  clients created=${clients.size} for ${instances.size} instances`)
} finally {
  realClearTimeout(watchdog)
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  Date.now = realNow
  _setLspLedgerClockForTesting()
  try {
    removeScratch(home)
  } catch (error) {
    console.log(`  [NOTE] ${home} was not removed — ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
}

const now = `${lines.join('\n').trimStart()}\n`
if (WRITE) {
  mkdirSync(path.dirname(RECORDING), { recursive: true })
  writeFileSync(RECORDING, now)
  console.log(`prove-lsp-instance-recording: recorded ${lines.length} lines in ${RECORDING_NAME}`)
  process.exit(failures === 0 ? 0 : 1)
}
if (recorded === now) {
  check(`createLSPServerInstance answers every scene as recorded (${lines.length} lines equal to ${RECORDING_NAME})`, true)
} else {
  sayDifferences(recorded, now)
  check(
    `createLSPServerInstance answers every scene as recorded in ${RECORDING_NAME}`,
    false,
    `mend ${DOOR} or its parts until the lines above are equal; only where the difference is meant, record it again with \`bun ${SELF} --write\` and commit the recording`,
  )
}
console.log(failures === 0 ? 'prove-lsp-instance-recording: green' : `prove-lsp-instance-recording: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
