#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-bus.ts
//  PROOF (Phase 3 Task 3.1): the Scribe↔Implementer bus envelope builders +
//  classifiers — modeled on teammateMailbox.ts create*/is* helpers — produce
//  well-formed {type:'scribe_protocol', kind, request_id, …} envelopes that
//  round-trip through serialize → isScribeProtocolMessage, while plain text and
//  the existing teammate protocol messages are NOT misclassified.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-bus.ts
// ============================================================================

import {
  buildDispatch,
  buildEscalate,
  buildProgress,
  buildControl,
  parseScribeEnvelope,
  serializeScribeEnvelope,
  isScribeProtocolMessage,
  isDispatchEnvelope,
  isEscalateEnvelope,
  isProgressEnvelope,
  isControlEnvelope,
  SCRIBE_PROTOCOL_TYPE,
} from '../../src/utils/scribe/scribeBus.js'
import { scribeBusEnabled } from '../../src/utils/scribe/scribeGates.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

const FROM = 'scribe@team-amanuensis'

console.log('============================================================')
console.log(' Scribe bus envelopes — Phase-3 Task 3.1 proof')
console.log('============================================================')

section('builders produce {type, kind, request_id, from, timestamp, …}')
const dispatch = buildDispatch(FROM, 'Implement Task X with TDD', { title: 'Task X', priority: 'high' })
const escalate = buildEscalate(FROM, 'Ambiguous spec — two valid interpretations', { needsOperator: true })
const progress = buildProgress(FROM, 'working', { detail: 'recon done; editing' })
const control = buildControl(FROM, 'pause', { detail: 'operator intervened' })

for (const [name, env, kind] of [
  ['dispatch', dispatch, 'dispatch'],
  ['escalate', escalate, 'escalate'],
  ['progress', progress, 'progress'],
  ['control', control, 'control'],
] as const) {
  check(`${name}: type === scribe_protocol`, env.type === SCRIBE_PROTOCOL_TYPE)
  check(`${name}: kind === '${kind}'`, env.kind === kind)
  check(`${name}: request_id present + tagged with kind + @from`, env.request_id.startsWith(`${kind}-`) && env.request_id.includes(`@${FROM}`))
  check(`${name}: from + timestamp present`, env.from === FROM && typeof env.timestamp === 'string' && env.timestamp.length > 0)
}
// builder-specific payloads
check('dispatch carries the task spec + title + priority', dispatch.task.includes('Task X') && dispatch.title === 'Task X' && dispatch.priority === 'high')
check('escalate carries reason + needsOperator', escalate.reason.length > 0 && escalate.needsOperator === true)
check('progress carries status', progress.status === 'working')
check('control carries the command', control.command === 'pause')

section('serialize → isScribeProtocolMessage round-trip + per-kind classifiers')
for (const [name, env, classifier] of [
  ['dispatch', dispatch, isDispatchEnvelope],
  ['escalate', escalate, isEscalateEnvelope],
  ['progress', progress, isProgressEnvelope],
  ['control', control, isControlEnvelope],
] as const) {
  const text = serializeScribeEnvelope(env)
  check(`${name}: isScribeProtocolMessage(serialized) true`, isScribeProtocolMessage(text) === true)
  check(`${name}: ${classifier.name}(serialized) matches`, classifier(text) !== null)
  // a different kind's classifier must NOT match
  check(`${name}: a foreign classifier does NOT match`, (name === 'dispatch' ? isEscalateEnvelope(text) : isDispatchEnvelope(text)) === null)
}

section('negatives — plain text + foreign protocol are NOT scribe envelopes')
check('plain text ⇒ not a scribe protocol message', isScribeProtocolMessage('just a normal teammate note') === false)
check('non-JSON garbage ⇒ false', isScribeProtocolMessage('{not json') === false)
check('existing teammate protocol (type:idle_notification) ⇒ false', isScribeProtocolMessage(JSON.stringify({ type: 'idle_notification', from: 'x' })) === false)
check('a JSON object with kind but wrong type ⇒ false', isScribeProtocolMessage(JSON.stringify({ kind: 'dispatch', request_id: 'x' })) === false)

section('parseScribeEnvelope REQUIRES a `from` sender (HB-0067)')
{
  const valid = buildDispatch('op', 'do x', { title: 'T', priority: 'high' })
  check('a well-formed dispatch WITH from parses', parseScribeEnvelope(JSON.stringify(valid)) !== null)
  check('a dispatch with NO from is REJECTED (null)', parseScribeEnvelope(JSON.stringify({ ...valid, from: undefined })) === null)
  check('a dispatch with EMPTY from is REJECTED (null)', parseScribeEnvelope(JSON.stringify({ ...valid, from: '' })) === null)
}

section('scribeBusEnabled() gates')
setStamp(true); delete process.env.MERCURY_SCRIBE_BUS
check('fork default ⇒ scribeBusEnabled() true', scribeBusEnabled() === true)
process.env.MERCURY_SCRIBE_BUS = '0'
check('MERCURY_SCRIBE_BUS=0 ⇒ false', scribeBusEnabled() === false)
delete process.env.MERCURY_SCRIBE_BUS
// the gate is stamp-independent.
setStamp(false)
check('bare stamp ⇒ STILL true (stamp-independence)', scribeBusEnabled() === true)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-BUS PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-BUS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
