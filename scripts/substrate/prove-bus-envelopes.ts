#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-bus-envelopes.ts
//  PROOF: the typed coordination envelopes that ride the teammate mailbox —
//  builders produce well-formed {type, kind, request_id, from, timestamp, …}
//  envelopes that round-trip through serialize → parse; plain text and the
//  existing teammate protocol messages are never misclassified; a malformed
//  envelope (a kind without its payload) is dropped rather than delivered; an
//  old hand-written envelope still parses and unknown extra fields ride
//  through (decoders are total); the hand-serialized-payload detector and the
//  verified note-sender rules hold; the format gate reads its flag.
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-bus-envelopes.ts
// ============================================================================
import {
  BUS_ENVELOPE_KINDS,
  BUS_PROTOCOL_TYPE,
  LEGACY_BUS_PROTOCOL_TYPE,
  buildControl,
  buildDispatch,
  buildEscalate,
  buildNote,
  buildProgress,
  busEnvelopesEnabled,
  isBusProtocolMessage,
  isControlEnvelope,
  isDispatchEnvelope,
  isEscalateEnvelope,
  isNoteEnvelope,
  isProgressEnvelope,
  looksLikeHandSerializedBusPayload,
  parseBusEnvelope,
  resolveNoteSender,
  serializeBusEnvelope,
} from '../../src/utils/swarm/busEnvelopes.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const FROM = 'team-lead'

console.log('============================================================')
console.log(' bus envelopes — proof')
console.log('============================================================')

section('builders produce {type, kind, request_id, from, timestamp, …}')
const dispatch = buildDispatch(FROM, 'Implement Task X with TDD', { title: 'Task X', priority: 'high' })
const escalate = buildEscalate('scout', 'Ambiguous spec — two valid interpretations', { needsOperator: true })
const progress = buildProgress('scout', 'working', { detail: 'recon done; editing' })
const control = buildControl(FROM, 'pause', { detail: 'operator intervened' })
const note = buildNote(FROM, 'read the spec first', { broadcast: true })
check('the kind vocabulary is the five kinds', BUS_ENVELOPE_KINDS.join(',') === 'dispatch,escalate,progress,control,note')
for (const [name, env, kind] of [
  ['dispatch', dispatch, 'dispatch'],
  ['escalate', escalate, 'escalate'],
  ['progress', progress, 'progress'],
  ['control', control, 'control'],
  ['note', note, 'note'],
] as const) {
  check(`${name}: type === the bus protocol type`, env.type === BUS_PROTOCOL_TYPE)
  check(`${name}: kind === '${kind}'`, env.kind === kind)
  check(`${name}: request_id present + tagged with kind + @from`, env.request_id.startsWith(`${kind}-`) && env.request_id.includes(`@${env.from}`))
  check(`${name}: from + timestamp present`, env.from.length > 0 && typeof env.timestamp === 'string' && env.timestamp.length > 0)
}
check('dispatch carries the task spec + title + priority', dispatch.task.includes('Task X') && dispatch.title === 'Task X' && dispatch.priority === 'high')
check('escalate carries reason + needsOperator', escalate.reason.length > 0 && escalate.needsOperator === true)
check('progress carries status', progress.status === 'working')
check('control carries the command', control.command === 'pause')
check('note carries text + the broadcast bit', note.text.length > 0 && note.broadcast === true)
let threw = false
try {
  buildNote('   ', 'unsourced')
} catch {
  threw = true
}
check('buildNote refuses an empty sender (a note must name its author)', threw)

section('serialize → parse round-trip + per-kind classifiers')
for (const [name, env, classifier, others] of [
  ['dispatch', dispatch, isDispatchEnvelope, [isEscalateEnvelope, isProgressEnvelope, isControlEnvelope, isNoteEnvelope]],
  ['escalate', escalate, isEscalateEnvelope, [isDispatchEnvelope, isProgressEnvelope, isControlEnvelope, isNoteEnvelope]],
  ['progress', progress, isProgressEnvelope, [isDispatchEnvelope, isEscalateEnvelope, isControlEnvelope, isNoteEnvelope]],
  ['control', control, isControlEnvelope, [isDispatchEnvelope, isEscalateEnvelope, isProgressEnvelope, isNoteEnvelope]],
  ['note', note, isNoteEnvelope, [isDispatchEnvelope, isEscalateEnvelope, isProgressEnvelope, isControlEnvelope]],
] as const) {
  const text = serializeBusEnvelope(env)
  check(`${name}: isBusProtocolMessage(serialized) true`, isBusProtocolMessage(text) === true)
  check(`${name}: parseBusEnvelope round-trips the kind + request_id`, parseBusEnvelope(text)?.kind === env.kind && parseBusEnvelope(text)?.request_id === env.request_id)
  check(`${name}: its own classifier matches`, classifier(text) !== null)
  check(`${name}: the other four classifiers stay null`, others.every(o => o(text) === null))
}

section('non-envelopes are never misclassified')
for (const [label, text] of [
  ['plain prose', 'please run the tests again'],
  ['JSON that is not an envelope', JSON.stringify({ type: 'permission_request', id: 'p1' })],
  ['a teammate protocol message', JSON.stringify({ type: 'shutdown_request', request_id: 'r1', from: 'x' })],
  ['an envelope with an unknown kind', JSON.stringify({ type: BUS_PROTOCOL_TYPE, kind: 'teleport', request_id: 'r', from: 'x', timestamp: 't' })],
  ['an envelope without a sender', JSON.stringify({ type: BUS_PROTOCOL_TYPE, kind: 'dispatch', request_id: 'r', from: '', timestamp: 't', task: 't' })],
  ['a dispatch without its task', JSON.stringify({ type: BUS_PROTOCOL_TYPE, kind: 'dispatch', request_id: 'r', from: 'x', timestamp: 't' })],
  ['a progress with a status outside the enum', JSON.stringify({ type: BUS_PROTOCOL_TYPE, kind: 'progress', request_id: 'r', from: 'x', timestamp: 't', status: 'sideways' })],
  ['a control with an unknown command', JSON.stringify({ type: BUS_PROTOCOL_TYPE, kind: 'control', request_id: 'r', from: 'x', timestamp: 't', command: 'reboot' })],
  ['not JSON at all', '{ not json'],
] as const) {
  check(`${label} ⇒ not an envelope`, isBusProtocolMessage(text) === false && parseBusEnvelope(text) === null)
}

section('decoders are total: old hand-written envelopes parse, unknown fields ride through')
const oldEnvelope = JSON.stringify({
  type: BUS_PROTOCOL_TYPE,
  kind: 'dispatch',
  request_id: 'x1',
  from: 'team-lead',
  timestamp: '2026-01-01T00:00:00Z',
  task: 't',
  route: { effort: 'high' },
})
const oldParsed = parseBusEnvelope(oldEnvelope)
check(
  'an OLD hand-written dispatch (only route.effort, no lane, no plan fields) still parses',
  oldParsed !== null && oldParsed.kind === 'dispatch' && (oldParsed as { route?: { effort?: string } }).route?.effort === 'high',
)
const forwardSafe = parseBusEnvelope(JSON.stringify({ ...JSON.parse(oldEnvelope), futureField: 'p1' }))
check(
  'an envelope carrying an UNKNOWN extra field still parses and keeps it (never refused on presence)',
  forwardSafe !== null && (forwardSafe as unknown as Record<string, unknown>).futureField === 'p1',
)

section('the hand-serialized payload detector')
check('a JSON string carrying type:dispatch trips', looksLikeHandSerializedBusPayload(JSON.stringify({ type: 'dispatch', task: 't' })))
check('a bare payload carrying kind:progress trips', looksLikeHandSerializedBusPayload('  {"kind":"progress","status":"done"}'))
check('a full serialized envelope trips too', looksLikeHandSerializedBusPayload(serializeBusEnvelope(dispatch)))
check('plain prose mentioning the words never trips', !looksLikeHandSerializedBusPayload('send a dispatch with type progress'))
check('unrelated JSON never trips', !looksLikeHandSerializedBusPayload(JSON.stringify({ type: 'question', content: 'x' })))

section('resolveNoteSender: the verified mailbox sender wins')
const n = buildNote('team-lead', 'ctx')
check('verified sender that matches the in-body from ⇒ that sender', resolveNoteSender('team-lead', n, 'scout') === 'team-lead')
check('no verified sender ⇒ dropped', resolveNoteSender(undefined, n, 'scout') === null)
check('in-body from that spoofs another agent ⇒ dropped', resolveNoteSender('mallory', n, 'scout') === null)
check('a note "from" the receiver itself ⇒ dropped', resolveNoteSender('scout', buildNote('scout', 'self'), 'scout') === null)

section('the protocol type: writers emit the neutral spelling; the retired spelling still decodes')
check('a fresh envelope carries the neutral type', dispatch.type === 'bus_protocol' && serializeBusEnvelope(note).includes('"type":"bus_protocol"'))
const legacyDispatch = JSON.stringify({ type: LEGACY_BUS_PROTOCOL_TYPE, kind: 'dispatch', request_id: 'legacy-1', from: 'team-lead', timestamp: '2026-01-01T00:00:00Z', task: 't' })
check(
  'a persisted envelope with the retired protocol spelling still parses as its kind',
  parseBusEnvelope(legacyDispatch)?.kind === 'dispatch' && isBusProtocolMessage(legacyDispatch) && isDispatchEnvelope(legacyDispatch) !== null,
)
check(
  'the retired spelling widens nothing else (an unknown kind still drops)',
  parseBusEnvelope(JSON.stringify({ type: LEGACY_BUS_PROTOCOL_TYPE, kind: 'teleport', request_id: 'legacy-2', from: 'x', timestamp: 't' })) === null,
)
check('the two spellings are distinct constants', BUS_PROTOCOL_TYPE !== LEGACY_BUS_PROTOCOL_TYPE)

section('the format gate reads its registry flag')
const stash = process.env.MERCURY_DAEMON_BUS
delete process.env.MERCURY_DAEMON_BUS
check('unset ⇒ on (default-on)', busEnvelopesEnabled() === true)
process.env.MERCURY_DAEMON_BUS = '0'
check("'0' ⇒ off (the one off-switch)", busEnvelopesEnabled() === false)
if (stash === undefined) delete process.env.MERCURY_DAEMON_BUS
else process.env.MERCURY_DAEMON_BUS = stash

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BUS ENVELOPE PROOFS PASS')
else console.log(`❌ ${failures} BUS ENVELOPE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
