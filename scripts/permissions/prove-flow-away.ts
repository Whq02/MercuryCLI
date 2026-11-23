import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'ask-clock-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
const { createRunnerAsks } = await import('../../src/daemon/runner/runnerAsks.ts')
const { createPeer } = await import('../../src/daemon/runner-wire/peer.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { askExpiredCause, askLimitMs, unansweredAskRefusal, FLOW_ASK_LIMIT_MINUTES, SOVEREIGN_ASK_LIMIT_MINUTES, CREWMATE_ASK_LIMIT_MINUTES } = await import('../../src/permissions/rules/askClock.ts')
const { isDenialResultText } = await import('../../src/engine/message-shapes/rejectionText.ts')
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
const OWN_CLOCKS: Record<string, number> = { flow: FLOW_ASK_LIMIT_MINUTES, sovereign: SOVEREIGN_ASK_LIMIT_MINUTES, default: 0, implement: 0, apollo: 0, dontAsk: 0 }
const CREWMATE_CLOCKS: Record<string, number> = { flow: FLOW_ASK_LIMIT_MINUTES, sovereign: SOVEREIGN_ASK_LIMIT_MINUTES, default: CREWMATE_ASK_LIMIT_MINUTES, implement: CREWMATE_ASK_LIMIT_MINUTES, apollo: CREWMATE_ASK_LIMIT_MINUTES, dontAsk: CREWMATE_ASK_LIMIT_MINUTES }
const ROAD: Array<[string, number, boolean, string?]> = [
  ...Object.entries(OWN_CLOCKS).map(([mode, minutes]): [string, number, boolean] => [mode, minutes * MINUTE, false]),
  ...Object.entries(CREWMATE_CLOCKS).map(([mode, minutes]): [string, number, boolean] => [mode, minutes * MINUTE, true]),
  ['sovereign', 12_000, false, '0.2'],
]

console.log('§1 the owner: one table of clocks')
check('flow 10 · sovereign 3 · a crewmate 10 elsewhere · a session\'s own ask none elsewhere',
  FLOW_ASK_LIMIT_MINUTES === 10 && SOVEREIGN_ASK_LIMIT_MINUTES === 3 && CREWMATE_ASK_LIMIT_MINUTES === 10 &&
  askLimitMs({ mode: 'flow', crewmate: false }) === 10 * MINUTE && askLimitMs({ mode: 'sovereign', crewmate: false }) === 3 * MINUTE &&
  askLimitMs({ mode: 'default', crewmate: false }) === 0 && askLimitMs({ mode: 'default', crewmate: true }) === 10 * MINUTE &&
  askLimitMs({ mode: 'sovereign', crewmate: true }) === 3 * MINUTE && askLimitMs({ mode: undefined, crewmate: true }) === 10 * MINUTE,
  'change the clock constants or askLimitMs in src/permissions/rules/askClock.ts')
process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0.2'
check('the knob replaces every clock that exists and never gives a clockless ask one',
  askLimitMs({ mode: 'flow', crewmate: false }) === 12_000 && askLimitMs({ mode: 'sovereign', crewmate: false }) === 12_000 &&
  askLimitMs({ mode: 'default', crewmate: true }) === 12_000 && askLimitMs({ mode: 'default', crewmate: false }) === 0,
  'change how askLimitMs in src/permissions/rules/askClock.ts reads MERCURY_PERMISSION_ASK_EXPIRY_MINUTES')
process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = '0'
check('knob 0 disables expiry everywhere', askLimitMs({ mode: 'flow', crewmate: false }) === 0 && askLimitMs({ mode: 'sovereign', crewmate: true }) === 0, 'change askLimitMs in src/permissions/rules/askClock.ts so a knob of 0 returns 0 for every mode')
delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
const words = unansweredAskRefusal('Bash', 3 * MINUTE)
check('the refusal is a typed denial the classifier reads, naming the limit and the next move',
  isDenialResultText(words) && words.includes('nobody answered the permission ask within 3m, so it expired and was refused') && words.includes('Work that does not depend on this action can continue') && words.includes('stop and say plainly'), `${words} — change unansweredAskRefusal in src/permissions/rules/askClock.ts, or isDenialResultText in src/engine/message-shapes/rejectionText.ts`)
check('the cause the wire carries names the expiry and the limit', askExpiredCause(10 * MINUTE) === 'expired unanswered after 10m', `got ${askExpiredCause(10 * MINUTE)} — change askExpiredCause in src/permissions/rules/askClock.ts`)

try {
  console.log('§2 the hosted runner\'s road: a session\'s own ask and a crewmate\'s in every mode, the knob, and the cause on the wire')
  for (const [mode, limit, crewmate, knob] of ROAD) {
    for (const winner of limit > 0 ? ['away', 'allow', 'deny', 'abort', 'close'] : ['wait']) {
      if (knob !== undefined) process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES = knob
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
      const tag = `host ${mode}${crewmate ? ' crewmate' : ''}${knob !== undefined ? ` knob ${knob}` : ''} ${winner}`
      check(`${tag}: the ask parks and carries the mode on the wire`, asks.parkedAsks() === 1 && seenParams?.mode === mode && (crewmate ? seenParams?.agent_id === 'crewmate-2' : seenParams?.agent_id === undefined), `${JSON.stringify(seenParams)} — check that the permission/request in src/daemon/runner/runnerAsks.ts parks the ask and sends the mode and agent_id`)
      check(`${tag}: ${limit > 0 ? `one clock of ${limit} ms arms` : 'no clock arms'}`, limit > 0 ? armed().length === 1 && armed()[0] === limit : armed().length === 0, `${JSON.stringify(armed())} — check the clock askLimitMs gives in src/permissions/rules/askClock.ts and how src/daemon/runner/runnerAsks.ts arms it`)
      if (winner === 'away') {
        advance(limit - 1)
        await tick()
        check(`${tag}: the ask stays until its deadline`, asks.parkedAsks() === 1 && results.length === 0, 'the ask in src/daemon/runner/runnerAsks.ts settled before its deadline')
        advance(1)
        await tick()
        check(`${tag}: the result is the typed refusal, naming the limit`, results.length === 1 && results[0].behavior === 'deny' && results[0].message === unansweredAskRefusal('AwayProbe', limit) && (knob === undefined || String(results[0].message).includes('within 12s')), `${JSON.stringify(results[0])} — the expiry in src/daemon/runner/runnerAsks.ts should resolve deny with unansweredAskRefusal from src/permissions/rules/askClock.ts`)
        check(`${tag}: the wire ask is withdrawn with the cause, both ledgers clear, the turn is not cut`, withdrawn === askExpiredCause(limit) && asks.parkedAsks() === 0 && asks.pendingControlRequestCount() === 0 && !ac.signal.aborted, `${JSON.stringify(withdrawn)} — the expiry in src/daemon/runner/runnerAsks.ts should withdraw the wire ask with askExpiredCause, clear both ledgers and leave the turn running`)
        answer?.({ outcome: 'allow' })
        await tick()
        check(`${tag}: a late yes cannot resurrect the refused call`, results.length === 1 && results[0].behavior === 'deny', 'the answer handler in src/daemon/runner/runnerAsks.ts must ignore an answer after the ask expired')
      } else if (winner === 'wait') {
        advance(60 * MINUTE)
        await tick()
        check(`${tag}: an hour later the ask is still parked for the operator`, asks.parkedAsks() === 1 && results.length === 0, 'a mode with no clock in askLimitMs (src/permissions/rules/askClock.ts) must arm none in src/daemon/runner/runnerAsks.ts')
        answer?.({ outcome: 'allow' })
        await tick()
        check(`${tag}: the operator's yes, whenever it comes, lands`, results.length === 1 && results[0].behavior === 'allow', 'the permission/request answer in src/daemon/runner/runnerAsks.ts must resolve the parked ask')
      } else {
        if (winner === 'allow') answer?.({ outcome: 'allow' })
        else if (winner === 'deny') answer?.({ outcome: 'deny', message: 'the operator said no' })
        else if (winner === 'abort') ac.abort()
        else host.end()
        await tick()
        check(`${tag}: clears the clock and settles once`, armed().length === 0 && results.length === 1 && results[0].message !== unansweredAskRefusal('AwayProbe', limit), 'the settle path in src/daemon/runner/runnerAsks.ts must clear its clock when an answer, abort or host close wins')
      }
      host.end(); runner.end(); ac.abort()
      await pending
      timers.clear()
      delete process.env.MERCURY_PERMISSION_ASK_EXPIRY_MINUTES
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
