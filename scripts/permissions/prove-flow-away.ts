import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'flow-away-'))
process.env.MERCURY_CONFIG_DIR = home
const { handleInteractivePermission } = await import('../../src/hooks/toolPermission/handlers/interactiveHandler.ts')
const { createRunnerAsks } = await import('../../src/cli/headless/runnerAsks.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const MESSAGE = 'the user is away; continue with an allowed tool call instead'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const realSet = globalThis.setTimeout
const realClear = globalThis.clearTimeout
const timers = new Map<object, { fire: () => void; remaining: number }>()
globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
  if (ms !== 300_000) return realSet(fn, ms, ...args)
  const handle = { unref() { return this } }
  timers.set(handle, { fire: fn, remaining: ms })
  return handle
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: unknown) => {
  if (!timers.delete(timer as object)) realClear(timer as ReturnType<typeof setTimeout>)
}) as typeof clearTimeout
function advance(ms: number) {
  for (const [handle, timer] of [...timers]) {
    timer.remaining -= ms
    if (timer.remaining <= 0) { timers.delete(handle); timer.fire() }
  }
}
let failures = 0
function check(label: string, ok: boolean) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
function local(mode: string) {
  const ac = new AbortController()
  const queue: any[] = []
  const results: any[] = []
  let grants = 0
  const ctx = {
    tool: { name: 'AwayProbe' }, input: {}, assistantMessage: { message: { id: 'away' } }, toolUseID: 'away',
    toolUseContext: { abortController: ac, getAppState: () => ({ toolPermissionContext: { mode } }) },
    pushToQueue: (item: any) => queue.push(item), removeFromQueue: () => { queue.length = 0 }, logDecision() {},
    cancelAndAbort() { ac.abort(); return { behavior: 'ask', message: 'aborted' } },
    buildDeny: (message: string) => ({ behavior: 'deny', message }),
    handleUserAllow: async () => { grants++; return { behavior: 'allow' } },
  }
  handleInteractivePermission({ ctx: ctx as never, description: '', result: { behavior: 'ask', message: 'probe' }, awaitAutomatedChecksBeforeDialog: true }, value => results.push(value))
  return { ac, queue, results, grants: () => grants }
}
try {
  for (const mode of ['flow', 'default', 'implement', 'sovereign', 'dontAsk']) {
    const h = local(mode)
    const card = h.queue[0]!
    check(`${mode}: only Flow arms one fixed five-minute timer`, timers.size === (mode === 'flow' ? 1 : 0))
    advance(299_999)
    check(`${mode}: nothing is withdrawn before five minutes`, h.queue.length === 1 && h.results.length === 0)
    advance(1)
    if (mode === 'flow') {
      check('card: away result is exactly the required sentence', h.results.length === 1 && h.results[0].behavior === 'deny' && h.results[0].message === MESSAGE)
      check('card: the ask is removed, not the parent turn', h.queue.length === 0 && !h.ac.signal.aborted)
      await card.onAllow({}, [])
      check('card: late yes cannot run or save anything', h.results.length === 1 && h.grants() === 0)
    } else check(`${mode}: five minutes does not change the ask`, h.queue.length === 1 && h.results.length === 0)
    h.ac.abort()
  }
  for (const winner of ['allow', 'abort', 'reject']) {
    const h = local('flow')
    const entry = h.queue[0]!
    if (winner === 'allow') await entry.onAllow({}, [])
    else if (winner === 'abort') h.ac.abort()
    else entry.onReject()
    check(`card: ${winner} clears its timer`, timers.size === 0)
    advance(300_000)
    check(`card: ${winner} wins exactly once`, h.results.length === 1 && h.results[0].message !== MESSAGE)
  }
  for (const winner of ['away', 'allow', 'abort', 'close']) {
    const toHost = new PassThrough()
    const toRunner = new PassThrough()
    const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
    const host = createPeer({ input: toHost, output: toRunner, side: 'host', log() {} })
    const capabilities = { holds_asks: true, elicitation: false, partial_rows: false }
    runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'away' }))
    await host.request('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities })
    const asks = createRunnerAsks(runner, () => capabilities)
    let answer: ((value: any) => void) | undefined
    let withdrawn = false
    host.onRequest('permission/request', (_params, ctx) => {
      ctx.signal.addEventListener('abort', () => { withdrawn = true })
      return new Promise(resolve => { answer = resolve }) as never
    })
    const ac = new AbortController()
    const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'flow' }, tasks: {}, sessionHooks: new Map() }
    let results: any[] = []
    const context = { abortController: ac, getAppState: () => state, setAppState() {}, messages: [], options: { tools: [] } }
    const tool = { name: 'AwayProbe', inputSchema: z.object({}), checkPermissions: async () => ({ behavior: 'ask', message: 'probe' }) }
    const pending = asks.createCanUseTool()(tool as never, {}, context as never, { message: { id: 'away' } } as never, 'away', { behavior: 'ask', message: 'probe' }).then(value => { results.push(value) })
    await tick()
    check(`host ${winner}: one ask parks and one fixed timer arms`, asks.parkedAsks() === 1 && timers.size === 1)
    if (winner === 'away') {
      advance(299_999)
      await tick()
      check('host: the ask stays until its actual five-minute deadline', asks.parkedAsks() === 1 && results.length === 0)
      advance(1)
      await tick()
      check('host: away result is exactly the required sentence', results.length === 1 && results[0].behavior === 'deny' && results[0].message === MESSAGE)
      check('host: expiry withdraws the wire ask and clears both ledgers without cutting the turn', withdrawn && asks.parkedAsks() === 0 && asks.pendingControlRequestCount() === 0 && !ac.signal.aborted)
      answer?.({ outcome: 'allow' })
      await tick()
      check('host: late yes cannot resurrect the expired call', results.length === 1 && results[0].behavior === 'deny')
    } else {
      if (winner === 'allow') answer?.({ outcome: 'allow' })
      else if (winner === 'abort') ac.abort()
      else host.end()
      await tick()
      check(`host: ${winner} clears the timer and settles once`, timers.size === 0 && results.length === 1 && results[0].message !== MESSAGE)
    }
    host.end(); runner.end(); ac.abort()
    await pending
  }
} finally {
  globalThis.setTimeout = realSet
  globalThis.clearTimeout = realClear
  rmSync(home, { recursive: true, force: true })
}
console.log(failures ? `Flow away rule: ${failures} FAILED` : 'Flow away rule: ALL PASS')
process.exit(failures ? 1 : 0)
