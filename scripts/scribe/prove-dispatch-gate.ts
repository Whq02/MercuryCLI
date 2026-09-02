#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-dispatch-gate.ts
//  PROOF (#41 R6): the SOURCE-side "one task at a time" gate. A scribe-role
//  PreToolUse(SendMessage) hook DENIES a 2nd normal-priority dispatch while one is
//  in flight (countOpenDispatches > 0), so the Scribe can't pile dispatches into the
//  Implementer's inbox — belt-and-suspenders with the daemon's DELIVERY back-pressure
//  (#41 R1). priority:'high' (operator-queued) BYPASSES; non-dispatch SendMessages and
//  every other tool pass straight through (safety-positive, never blocks anything else).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-dispatch-gate.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
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

const g = (await import('../../src/utils/hooks/scribeDispatchGate.js')) as typeof import('../../src/utils/hooks/scribeDispatchGate.js')

console.log('============================================================')
console.log(' Source dispatch-gate — one task at a time at the source (#41 R6)')
console.log('============================================================')

section('evaluateDispatchGate (pure)')
check('non-dispatch (progress) ⇒ allow even with work in flight', g.evaluateDispatchGate({ messageType: 'progress', priority: undefined, openInFlight: 3 }).allow === true)
check('plain text (no type) ⇒ allow', g.evaluateDispatchGate({ messageType: undefined, priority: undefined, openInFlight: 9 }).allow === true)
check('dispatch + nothing in flight ⇒ allow', g.evaluateDispatchGate({ messageType: 'dispatch', priority: 'normal', openInFlight: 0 }).allow === true)
check('dispatch + 1 in flight ⇒ DENY (one at a time)', g.evaluateDispatchGate({ messageType: 'dispatch', priority: 'normal', openInFlight: 1 }).allow === false && g.evaluateDispatchGate({ messageType: 'dispatch', priority: 'normal', openInFlight: 1 }).rule === 'in-flight-hold')
check('dispatch + priority:high ⇒ BYPASS (operator-queued jumps)', g.evaluateDispatchGate({ messageType: 'dispatch', priority: 'high', openInFlight: 5 }).allow === true && g.evaluateDispatchGate({ messageType: 'dispatch', priority: 'high', openInFlight: 5 }).rule === 'high-priority-bypass')

section('the re-prompt is leak-proof (never names the daemon/bus to the operator)')
check('re-prompt steers to supersede/batch/wait, mentions priority:high escape', /supersede|SUPERSEDE/.test(g.SCRIBE_DISPATCH_GATE_REPROMPT) && /batch|BATCH/.test(g.SCRIBE_DISPATCH_GATE_REPROMPT) && /priority/.test(g.SCRIBE_DISPATCH_GATE_REPROMPT))
check('re-prompt does NOT leak daemon/bus internals', !/daemon|mailbox|bridge/i.test(g.SCRIBE_DISPATCH_GATE_REPROMPT))

section('wiring (structural)')
const gate = src('utils', 'hooks', 'scribeDispatchGate.ts')
check('PreToolUse hook on the SendMessage tool, reading openInFlight from countOpenDispatches', /addFunctionHook\([\s\S]{0,200}'PreToolUse'[\s\S]{0,80}SEND_MESSAGE_TOOL_NAME/.test(gate) && /countOpenDispatches\(messages/.test(gate))
check('reads the pending dispatch from the PreToolUse hookInput (not the transcript)', /hook_event_name\b[\s\S]{0,80}'PreToolUse'/.test(gate) && /tool_input\?\.message/.test(gate))
const hooks = src('utils', 'hooks', 'scribeImplementerHooks.ts')
check('engageScribeHooks installs the gate; disengage removes it (Scribe process only)', /registerScribeDispatchGate\(setAppState, sessionId\)/.test(hooks) && /unregisterScribeDispatchGate\(setAppState, sessionId\)/.test(hooks))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DISPATCH-GATE PROOFS PASS')
else console.log(`❌ ${failures} DISPATCH-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
