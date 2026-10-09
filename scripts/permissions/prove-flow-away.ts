import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'ask-clock-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
const { handleInteractivePermission } = await import('../../src/hooks/toolPermission/handlers/interactiveHandler.ts')
const { createRunnerAsks } = await import('../../src/cli/headless/runnerAsks.ts')
const { createPeer } = await import('../../src/runner/wire/peer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { askExpiredCause, askLimitMs, unansweredAskRefusal, FLOW_ASK_LIMIT_MINUTES, SOVEREIGN_ASK_LIMIT_MINUTES, CREWMATE_ASK_LIMIT_MINUTES } = await import('../../src/utils/permissions/askClock.ts')
const { isDenialResultText } = await import('../../src/utils/messages/rejectionText.ts')
const MINUTE = 60_000
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const realSet = globalThis.setTimeout
const realClear = globalThis.clearTimeout
const timers = new Map<object, { fire: () => void; remaining: number; ms: number }>()
globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
  if (ms < 10_000) return realSet(fn, ms, ...args)
  const handle = { unref() { return this } }
  timers.set(handle, { fire: fn, remaining: ms, ms })
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
const armed = () => [...timers.values()].map(t => t.ms)
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const CARD_CLOCKS: Record<string, number> = { flow: FLOW_ASK_LIMIT_MINUTES, sovereign: SOVEREIGN_ASK_LIMIT_MINUTES, default: 0, implement: 0, apollo: 0, dontAsk: 0 }
const CREWMATE_CLOCKS: Record<string, number> = { flow: FLOW_ASK_LIMIT_MINUTES, sovereign: SOVEREIGN_ASK_LIMIT_MINUTES, default: CREWMATE_ASK_LIMIT_MINUTES, implement: CREWMATE_ASK_LIMIT_MINUTES, apollo: CREWMATE_ASK_LIMIT_MINUTES, dontAsk: CREWMATE_ASK_LIMIT_MINUTES }

function local(mode: string, agentId?: string) {
  const ac = new AbortController()
  const queue: any[] = []
  const results: any[] = []
  let grants = 0
  const ctx = {
    tool: { name: 'AwayProbe' }, input: {}, assistantMessage: { message: { id: 'away' } }, toolUseID: 'away',
    toolUseContext: { abortController: ac, getAppState: () => ({ toolPermissionContext: { mode } }), ...(agentId !== undefined ? { agentId } : {}) },
    pushToQueue: (item: any) => queue.push(item), removeFromQueue: () => { queue.length = 0 }, logDecision() {},
    cancelAndAbort() { ac.abort(); return { behavior: 'ask', message: 'aborted' } },
    buildDeny: (message: string) => ({ behavior: 'deny', message }),
    handleUserAllow: async () => { grants++; return { behavior: 'allow' } },
  }
  handleInteractivePermission({ ctx: ctx as never, description: '', result: { behavior: 'ask', message: 'probe' }, awaitAutomatedChecksBeforeDialog: true }, value => results.push(value))
  return { ac, queue, results, grants: () => grants }
}

console.log('§1 the owner: one table of clocks')
check('flow 10 · sovereign 3 · a crewmate 10 elsewhere · a session\'s own ask none elsewhere',
  FLOW_ASK_LIMIT_MINUTES === 10 && SOVEREIGN_ASK_LIMIT_MINUTES === 3 && CREWMATE_ASK_LIMIT_MINUTES === 10 &&
  askLimitMs({ mode: 'flow', crewmate: false }) === 10 * MINUTE && askLimitMs({ mode: 'sovereign', crewmate: false }) === 3 * MINUTE &&
  askLimitMs({ mode: 'default', crewmate: false }) === 0 && askLimitMs({ mode: 'default', crewmate: true }) === 10 * MINUTE &&
  askLimitMs({ mode: 'sovereign', crewmate: true }) === 3 * MINUTE && askLimitMs({ mode: undefined, crewmate: true }) === 10 * MINUTE)
process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.2'
check('the knob replaces every clock that exists and never gives a clockless ask one',
  askLimitMs({ mode: 'flow', crewmate: false }) === 12_000 && askLimitMs({ mode: 'sovereign', crewmate: false }) === 12_000 &&
  askLimitMs({ mode: 'default', crewmate: true }) === 12_000 && askLimitMs({ mode: 'default', crewmate: false }) === 0)
process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0'
check('knob 0 disables expiry everywhere', askLimitMs({ mode: 'flow', crewmate: false }) === 0 && askLimitMs({ mode: 'sovereign', crewmate: true }) === 0)
delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
const words = unansweredAskRefusal('Bash', 3 * MINUTE)
check('the refusal is a typed denial the classifier reads, naming the limit and the next move',
  isDenialResultText(words) && words.includes('nobody answered the permission ask within 3m, so it expired and was refused') && words.includes('Work that does not depend on this action can continue') && words.includes('stop and say plainly'), words)
check('the cause the wire carries names the expiry and the limit', askExpiredCause(10 * MINUTE) === 'expired unanswered after 10m')

try {
  console.log('§2 the foreground card, a session\'s own ask, every mode')
  for (const mode of Object.keys(CARD_CLOCKS)) {
    const minutes = CARD_CLOCKS[mode]!
    const h = local(mode)
    const card = h.queue[0]!
    check(`${mode}: ${minutes > 0 ? `one ${minutes}-minute clock arms` : 'no clock arms'}`, minutes > 0 ? armed().length === 1 && armed()[0] === minutes * MINUTE : armed().length === 0, JSON.stringify(armed()))
    if (minutes > 0) {
      advance(minutes * MINUTE - 1)
      check(`${mode}: nothing is withdrawn before the ${minutes} minutes`, h.queue.length === 1 && h.results.length === 0)
      advance(1)
      check(`${mode}: the card leaves and the call is refused with the typed denial`, h.queue.length === 0 && h.results.length === 1 && h.results[0].behavior === 'deny' && h.results[0].message === unansweredAskRefusal('AwayProbe', minutes * MINUTE), JSON.stringify(h.results[0]))
      check(`${mode}: the ask is removed, not the parent turn`, !h.ac.signal.aborted)
      await card.onAllow({}, [])
      check(`${mode}: a late yes cannot run or save anything`, h.results.length === 1 && h.grants() === 0)
    } else {
      advance(60 * MINUTE)
      check(`${mode}: an hour does not change the ask — it waits for the operator`, h.queue.length === 1 && h.results.length === 0)
    }
    h.ac.abort()
    timers.clear()
  }

  console.log('§3 the foreground card, a crewmate\'s ask, every mode')
  for (const mode of Object.keys(CREWMATE_CLOCKS)) {
    const minutes = CREWMATE_CLOCKS[mode]!
    const h = local(mode, 'crewmate-1')
    check(`${mode}: a crewmate's card arms a ${minutes}-minute clock`, armed().length === 1 && armed()[0] === minutes * MINUTE, JSON.stringify(armed()))
    advance(minutes * MINUTE)
    check(`${mode}: the crewmate's card is refused at ${minutes} minutes with the same words`, h.queue.length === 0 && h.results[0]?.message === unansweredAskRefusal('AwayProbe', minutes * MINUTE))
    h.ac.abort()
    timers.clear()
  }

  console.log('§4 the card: an answer clears the clock and wins exactly once')
  for (const winner of ['allow', 'abort', 'reject']) {
    const h = local('flow')
    const entry = h.queue[0]!
    if (winner === 'allow') await entry.onAllow({}, [])
    else if (winner === 'abort') h.ac.abort()
    else entry.onReject()
    check(`card: ${winner} clears its clock`, armed().length === 0)
    advance(10 * MINUTE)
    check(`card: ${winner} wins exactly once`, h.results.length === 1 && h.results[0].message !== unansweredAskRefusal('AwayProbe', 10 * MINUTE))
    timers.clear()
  }

  console.log('§5 the card: the knob scales the clock')
  process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.2'
  {
    const h = local('sovereign')
    check('sovereign under the knob arms a 12-second clock', armed().length === 1 && armed()[0] === 12_000, JSON.stringify(armed()))
    advance(12_000)
    check('the refusal names the scaled limit', h.results[0]?.message === unansweredAskRefusal('AwayProbe', 12_000) && String(h.results[0]?.message).includes('within 12s'))
    h.ac.abort()
    timers.clear()
  }
  delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES

  console.log('§6 the hosted runner\'s road, every mode, and the cause on the wire')
  for (const [mode, minutes, crewmate] of [['flow', 10, false], ['sovereign', 3, false], ['default', 0, false], ['implement', 0, false], ['default', 10, true], ['sovereign', 3, true]] as Array<[string, number, boolean]>) {
    for (const winner of minutes > 0 ? ['away', 'allow', 'abort', 'close'] : ['wait']) {
      const toHost = new PassThrough()
      const toRunner = new PassThrough()
      const runner = createPeer({ input: toRunner, output: toHost, side: 'runner', log() {} })
      const host = createPeer({ input: toHost, output: toRunner, side: 'host', log() {} })
      const capabilities = { holds_asks: true, elicitation: false, partial_rows: false }
      runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '1.0.0', pid: process.pid }, session_id: 'away' }))
      await host.request('initialize', { protocol: 1, host: { name: 'proof', version: '1' }, capabilities })
      const asks = createRunnerAsks(runner, () => capabilities)
      let answer: ((value: any) => void) | undefined
      let withdrawn: unknown = null
      let seenParams: any = null
      host.onRequest('permission/request', (params, ctx) => {
        seenParams = params
        ctx.signal.addEventListener('abort', () => { withdrawn = ctx.signal.reason })
        return new Promise(resolve => { answer = resolve }) as never
      })
      const ac = new AbortController()
      const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode }, tasks: {}, sessionHooks: new Map() }
      const results: any[] = []
      const context = { abortController: ac, getAppState: () => state, setAppState() {}, messages: [], options: { tools: [] }, ...(crewmate ? { agentId: 'crewmate-2' } : {}) }
      const tool = { name: 'AwayProbe', inputSchema: z.object({}), checkPermissions: async () => ({ behavior: 'ask', message: 'probe' }) }
      const pending = asks.createCanUseTool()(tool as never, {}, context as never, { message: { id: 'away' } } as never, 'away', { behavior: 'ask', message: 'probe' }).then(value => { results.push(value) })
      await tick()
      const tag = `host ${mode}${crewmate ? ' crewmate' : ''} ${winner}`
      check(`${tag}: the ask parks and carries the mode on the wire`, asks.parkedAsks() === 1 && seenParams?.mode === mode && (crewmate ? seenParams?.agent_id === 'crewmate-2' : seenParams?.agent_id === undefined), JSON.stringify(seenParams))
      check(`${tag}: ${minutes > 0 ? `one ${minutes}-minute clock arms` : 'no clock arms'}`, minutes > 0 ? armed().length === 1 && armed()[0] === minutes * MINUTE : armed().length === 0, JSON.stringify(armed()))
      if (winner === 'away') {
        advance(minutes * MINUTE - 1)
        await tick()
        check(`${tag}: the ask stays until its deadline`, asks.parkedAsks() === 1 && results.length === 0)
        advance(1)
        await tick()
        check(`${tag}: the result is the typed refusal`, results.length === 1 && results[0].behavior === 'deny' && results[0].message === unansweredAskRefusal('AwayProbe', minutes * MINUTE), JSON.stringify(results[0]))
        check(`${tag}: the wire ask is withdrawn with the cause, both ledgers clear, the turn is not cut`, withdrawn === askExpiredCause(minutes * MINUTE) && asks.parkedAsks() === 0 && asks.pendingControlRequestCount() === 0 && !ac.signal.aborted, JSON.stringify(withdrawn))
        answer?.({ outcome: 'allow' })
        await tick()
        check(`${tag}: a late yes cannot resurrect the refused call`, results.length === 1 && results[0].behavior === 'deny')
      } else if (winner === 'wait') {
        advance(60 * MINUTE)
        await tick()
        check(`${tag}: an hour later the ask is still parked for the operator`, asks.parkedAsks() === 1 && results.length === 0)
        answer?.({ outcome: 'allow' })
        await tick()
        check(`${tag}: the operator's yes, whenever it comes, lands`, results.length === 1 && results[0].behavior === 'allow')
      } else {
        if (winner === 'allow') answer?.({ outcome: 'allow' })
        else if (winner === 'abort') ac.abort()
        else host.end()
        await tick()
        check(`${tag}: clears the clock and settles once`, armed().length === 0 && results.length === 1 && results[0].message !== unansweredAskRefusal('AwayProbe', minutes * MINUTE))
      }
      host.end(); runner.end(); ac.abort()
      await pending
      timers.clear()
    }
  }
} finally {
  globalThis.setTimeout = realSet
  globalThis.clearTimeout = realClear
  delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
  rmSync(home, { recursive: true, force: true })
}
console.log(failures ? `the ask clock: ${failures} FAILED` : 'the ask clock: ALL PASS')
process.exit(failures ? 1 : 0)
