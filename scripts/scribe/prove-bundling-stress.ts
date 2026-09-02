#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-bundling-stress.ts
//  PROOF (#41): the prompt-bundling PHASE-OUT is heavily enforced + stress-tested —
//  the Implementer works STRICTLY one task at a time, even under stress (a turn that
//  runs far longer than the old 15s delivery-clock idle heuristic).
//
//  The fix: a PRECISE turn-active signal (busy from a user-frame delivery → the
//  child's stream-json `result` frame), replacing the heuristic that released
//  back-pressure mid-task and let a 2nd dispatch land. This proof exercises:
//   (1) the pure decision core (isTurnResultFrame / decideWorkerBusy / getMaxTurnMs);
//   (2) a REAL stress-test: a burst of N dispatches driven through the actual
//       drainScribeDispatches against a temp-dir mailbox + a simulated turn cycle —
//       asserting one-at-a-time, FIFO, held-while-active, and the precise-over-
//       heuristic win (a long turn still holds);
//   (3) structural wiring (roster sets/clears/ resets turnActive; back-pressure uses it).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-bundling-stress.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const lls = (await import('../../src/daemon/longLivedSupervisor.js')) as typeof import('../../src/daemon/longLivedSupervisor.js')

console.log('============================================================')
console.log(' Prompt-bundling phase-out — stress-tested one-at-a-time (#41)')
console.log('============================================================')

section('isTurnResultFrame — the turn-complete signal')
check('a result frame ⇒ true', lls.isTurnResultFrame('{"type":"result","subtype":"success"}') === true)
check('an assistant frame ⇒ false', lls.isTurnResultFrame('{"type":"assistant","message":{}}') === false)
check('a usage frame is not a turn-end', lls.isTurnResultFrame('{"type":"assistant","message":{"usage":{"input_tokens":1}}}') === false)
check('garbage / partial JSON ⇒ false (never throws)', lls.isTurnResultFrame('{not json') === false && lls.isTurnResultFrame('') === false)

section('decideWorkerBusy — PRECISE over the 15s heuristic')
const idleMs = 15_000
const ago = (ms: number) => 1_000_000 + ms // a `now` helper relative to a fixed base
// turnActive true ⇒ busy regardless of how long ago the delivery was (the stress win).
check('turn active + delivered LONG ago (10×idleMs) ⇒ STILL busy (precise; heuristic would release)',
  lls.decideWorkerBusy({ turnActive: true, turnStartedAt: 1_000_000, now: 1_000_000 + 10 * idleMs, lastDeliveredAt: 1_000_000, idleMs }).busy === true)
check('turn active within cap ⇒ busy (basis turn)',
  lls.decideWorkerBusy({ turnActive: true, turnStartedAt: 1_000_000, now: 1_000_000 + 5_000, lastDeliveredAt: 1_000_000, idleMs }).basis === 'turn')
check('turn active PAST the safety cap ⇒ released (presumed wedged; never starves)',
  lls.decideWorkerBusy({ turnActive: true, turnStartedAt: 1_000_000, now: 1_000_000 + lls.DEFAULT_MAX_TURN_MS + 1, lastDeliveredAt: 1_000_000, idleMs }).busy === false)
check('turn DONE (result arrived, turnActive false) ⇒ NOT busy (precise idle)',
  lls.decideWorkerBusy({ turnActive: false, turnStartedAt: undefined, now: 2_000_000, lastDeliveredAt: 1_000_000, idleMs }).busy === false)
check('no turn boundary observed yet (undefined) + recent delivery ⇒ delivery-clock fallback = busy',
  lls.decideWorkerBusy({ turnActive: undefined, turnStartedAt: undefined, now: 1_000_000 + 1_000, lastDeliveredAt: 1_000_000, idleMs }).basis === 'delivery-clock')
check('undefined + nothing ever delivered ⇒ not busy (no basis to hold)',
  lls.decideWorkerBusy({ turnActive: undefined, turnStartedAt: undefined, now: 1_000_000, lastDeliveredAt: undefined, idleMs }).busy === false)
check('getMaxTurnMs env-tunable; junk ⇒ default', lls.getMaxTurnMs('600000') === 600000 && lls.getMaxTurnMs(undefined) === lls.DEFAULT_MAX_TURN_MS && lls.getMaxTurnMs('0') === lls.DEFAULT_MAX_TURN_MS)

section('STRESS: a burst of 12 dispatches through the REAL drain — strictly one per turn')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')
const mb = (await import('../../src/utils/teammateMailbox.js')) as typeof import('../../src/utils/teammateMailbox.js')
const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')
const SAVE_CFG = process.env.MERCURY_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'prove-bundle-'))
process.env.MERCURY_CONFIG_DIR = dir
const N = 12
for (let i = 1; i <= N; i++) {
  const env = bus.buildDispatch('scribe', `task ${i}`, { title: `T${i}` })
  await mb.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(env), timestamp: new Date(1_700_000_000_000 + i).toISOString() }, 'scribe')
}
// Simulate the daemon: a precise turn-active flag set on delivery (reply) and cleared
// when "the result frame arrives" (we clear it between turns). isBusy reads it.
let turnActive = false
const delivered: string[] = []
let maxConcurrent = 0
let inFlight = 0
const roster = {
  reply: async (_short: string, frame: string): Promise<boolean> => {
    const m = JSON.parse(frame) as { message: { content: string } }
    // A dispatch frame is prefixed with DISPATCH_REPORT_BACK_FRAMING (a report-back
    // <system-reminder>); the title (T{i}) is the first line of the body AFTER it.
    // `.pop()` returns the whole string when the separator is absent, so this stays
    // correct whether or not the framing is present.
    const body = m.message.content.split('</system-reminder>\n\n').pop()!
    delivered.push(body.split('\n')[0]!)
    turnActive = true // turn starts
    inFlight++
    if (inFlight > maxConcurrent) maxConcurrent = inFlight
    return true
  },
}
const drain = () => bridge.drainScribeDispatches(roster, { short: 'implementer', agentName: 'implementer', teamName: 'scribe', isBusy: () => turnActive })
// Run many turns: each turn = (drain delivers ≤1) then (several drains while ACTIVE deliver 0)
// then (turn completes → next drain delivers the next). Stress: long active windows.
const perRound: number[] = []
let guard = 0
while (delivered.length < N && guard < 200) {
  guard++
  const d = await drain()
  perRound.push(d)
  if (d > 0) {
    // a task is now in flight; hammer the drain WHILE the turn is active — must hold (0)
    const held1 = await drain()
    const held2 = await drain()
    check(`turn active after T${delivered.length} ⇒ subsequent drains HOLD (0,0)`, held1 === 0 && held2 === 0, `got ${held1},${held2}`)
    // turn completes (result frame): clear + record one task finished
    inFlight--
    turnActive = false
  }
}
check('every drain delivered AT MOST one (strictly one task at a time)', perRound.every(x => x <= 1), `rounds=${JSON.stringify(perRound)}`)
check('max concurrent in-flight was exactly 1 (never 2 tasks at once)', maxConcurrent === 1, `maxConcurrent=${maxConcurrent}`)
check('ALL 12 dispatches eventually delivered (none starved)', delivered.length === N, `delivered=${delivered.length}`)
check('FIFO order preserved (T1..T12)', delivered.join(',') === Array.from({ length: N }, (_, i) => `T${i + 1}`).join(','), delivered.join(','))
SAVE_CFG === undefined ? delete process.env.MERCURY_CONFIG_DIR : (process.env.MERCURY_CONFIG_DIR = SAVE_CFG)

section('wiring (structural)')
const rosterSrc = src('daemon', 'roster.ts')
check('reply sets turnActive=true on a user-frame delivery (turn start)', /h\.longLived\.turnActive = true/.test(rosterSrc) && /h\.longLived\.turnStartedAt = Date\.now\(\)/.test(rosterSrc))
check('the stdout drain clears turnActive on the result frame (turn end)', /if \(isTurnResultParsedFrame\(frame\)\)/.test(rosterSrc) && /ll\.turnActive = false/.test(rosterSrc))
check('(re)spawn resets turn state (no stuck-busy on a fresh child)', /ll\.turnActive = false\r?\n\s*ll\.turnStartedAt = undefined/.test(rosterSrc))
check('isLongLivedIdle / back-pressure use decideWorkerBusy (precise)', /decideWorkerBusy\(\{/.test(rosterSrc) && /turnActive: ll\.turnActive/.test(rosterSrc))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BUNDLING-STRESS PROOFS PASS')
else console.log(`❌ ${failures} BUNDLING-STRESS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
