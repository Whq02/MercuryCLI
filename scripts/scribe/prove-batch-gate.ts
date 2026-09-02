#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-batch-gate.ts
//  PROOF (#47 batching/pacing): the operator's /batch approve/deny brake.
//   (a) scribeBatchGate state machine: default auto (always approved); deny ⇒ manual+
//       held; approve ⇒ released (stays manual); auto ⇒ re-approved; reset ⇒ default;
//   (b) evaluateBatchHold pure verdict (auto⇒never held; manual+approved⇒no; manual+
//       denied⇒held);
//   (c) evaluateDispatchGate honors the batch hold: a DENIED batch holds even a
//       priority:'high' dispatch (the operator's pause is the strongest signal), but
//       NEVER a non-dispatch (progress/escalate/control flow freely — no wedge);
//   (d) the /batch command: fork+scribe gated, approve/deny/auto/manual/status drive
//       the gate; supportsNonInteractive; registered in commands.ts;
//   (e) engage resets the gate (no stale pause leaks across sessions).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-batch-gate.ts
// ============================================================================
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
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' /batch approve/deny brake + dispatch-gate integration (#47)')
console.log('============================================================')

const gate = (await import('../../src/utils/scribe/scribeBatchGate.js')) as typeof import('../../src/utils/scribe/scribeBatchGate.js')
const dg = (await import('../../src/utils/hooks/scribeDispatchGate.js')) as typeof import('../../src/utils/hooks/scribeDispatchGate.js')

section('(a) scribeBatchGate state machine')
gate.resetBatchGate()
check('default is auto + approved (bypass/Hermes ⇒ no friction)', gate.getBatchMode() === 'auto' && gate.isBatchApproved() === true)
gate.denyBatch()
check('deny ⇒ manual + NOT approved (held)', gate.getBatchMode() === 'manual' && gate.isBatchApproved() === false)
gate.approveBatch()
check('approve ⇒ approved (stays manual so the next batch re-gates)', gate.getBatchMode() === 'manual' && gate.isBatchApproved() === true)
gate.setBatchMode('auto')
check('auto ⇒ always approved again', gate.getBatchMode() === 'auto' && gate.isBatchApproved() === true)
gate.denyBatch()
gate.resetBatchGate()
check('reset ⇒ back to the default (auto/approved)', gate.getBatchMode() === 'auto' && gate.isBatchApproved() === true)

section('(b) evaluateBatchHold pure verdict')
check('auto ⇒ never held', gate.evaluateBatchHold({ mode: 'auto', approved: false }).held === false)
check('manual + approved ⇒ not held', gate.evaluateBatchHold({ mode: 'manual', approved: true }).held === false)
check('manual + denied ⇒ HELD', gate.evaluateBatchHold({ mode: 'manual', approved: false }).held === true)

section('(c) evaluateDispatchGate honors the batch hold')
// a DENIED batch holds even a high-priority dispatch (the operator's pause wins)
check('batch denied ⇒ a normal dispatch is HELD (batch-held)', dg.evaluateDispatchGate({ messageType: 'dispatch', priority: 'normal', openInFlight: 0, batchApproved: false }).rule === 'batch-held')
check('batch denied ⇒ even a HIGH-priority dispatch is held', dg.evaluateDispatchGate({ messageType: 'dispatch', priority: 'high', openInFlight: 0, batchApproved: false }).allow === false)
// coordination is NEVER a dispatch ⇒ flows freely even when paused (no wedge)
check('batch denied ⇒ a non-dispatch (progress/escalate) still passes', dg.evaluateDispatchGate({ messageType: 'progress', priority: undefined, openInFlight: 5, batchApproved: false }).allow === true)
// approved/auto ⇒ the prior one-at-a-time semantics are unchanged
check('batch approved + in-flight ⇒ still one-at-a-time hold (unchanged)', dg.evaluateDispatchGate({ messageType: 'dispatch', priority: 'normal', openInFlight: 1, batchApproved: true }).rule === 'in-flight-hold')
check('batch approved + high-pri + in-flight ⇒ high bypass (unchanged)', dg.evaluateDispatchGate({ messageType: 'dispatch', priority: 'high', openInFlight: 1, batchApproved: true }).rule === 'high-priority-bypass')
check('batchApproved omitted ⇒ byte-identical to before (no batch-held)', dg.evaluateDispatchGate({ messageType: 'dispatch', priority: 'normal', openInFlight: 0 }).rule === 'clear')

// (d) the /batch command imports messageQueueManager, which transitively reaches
// color-diff-napi (a native dep unloadable under `bun run`, per the loadability note),
// so the COMMAND is asserted structurally — the gate BEHAVIOR it drives is exercised
// live in (a)-(c) against the real scribeBatchGate. batchGateStatus() IS loadable + tested.
section('(d) the /batch command (structural — unloadable chain) + status helper (live)')
gate.resetBatchGate()
check('batchGateStatus() reflects auto (live)', /^auto/.test(gate.batchGateStatus()))
gate.denyBatch()
check('batchGateStatus() reflects a paused manual hold (live)', /PAUSED/.test(gate.batchGateStatus()))
gate.resetBatchGate()
const batchSrc = src('commands', 'batch', 'index.ts')
check("/batch is type:'local' name:'batch'", /type:\s*'local'/.test(batchSrc) && /name:\s*'batch'/.test(batchSrc))
check('/batch scribe-gated (the stamp conjunct folded away, )', /isEnabled:\s*\(\)\s*=>\s*isScribeModeOn\(\)/.test(batchSrc))
check('/batch supportsNonInteractive', /supportsNonInteractive:\s*true/.test(batchSrc))
check('/batch approve ⇒ approveBatch()', /case 'approve'[\s\S]{0,120}approveBatch\(\)/.test(batchSrc))
check('/batch deny ⇒ denyBatch()', /case 'deny'[\s\S]{0,160}denyBatch\(\)/.test(batchSrc))
check('/batch auto|manual ⇒ setBatchMode()', /setBatchMode\('auto'\)/.test(batchSrc) && /setBatchMode\('manual'\)/.test(batchSrc))
check('/batch status reads the live queue via buildScribeBatchLedger(getCommandQueueSnapshot())', /buildScribeBatchLedger\(getCommandQueueSnapshot\(\)\)/.test(batchSrc))

section('(e) wiring (structural)')
const cmds = src('commands.ts')
check('commands.ts imports + lists /batch', /import batch from '\.\/commands\/batch\/index\.js'/.test(cmds) && /\n\s*batch,/.test(cmds))
const hooks = src('utils', 'hooks', 'scribeImplementerHooks.ts')
check('engageScribeHooks resets the batch gate (no stale pause leak)', /resetBatchGate\(\)/.test(hooks))
const dgsrc = src('utils', 'hooks', 'scribeDispatchGate.ts')
check('the dispatch-gate hook reads isBatchApproved()', /isBatchApproved\(\)/.test(dgsrc))
const repl = src('components', 'PromptInput', 'PromptInput.tsx')
check('the scribe launch tooltip surfaces /all + /batch', /\/all shares with the Implementer/.test(repl) && /\/batch approve\|deny/.test(repl))
// #47 S13 (RE-TRUED by steer-removal): the queued-prompts strip died with
// the operator-facing pen — no strip renders anywhere, chatroom included.
// POISON: its mount must not return to the composer.
check('S13: the queued strip stays dead (no mount in the composer — steer-removal)', !/PromptInputQueuedCommands/.test(repl) && !/queuedStripOwner/.test(repl))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BATCH-GATE PROOFS PASS')
else console.log(`❌ ${failures} BATCH-GATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
