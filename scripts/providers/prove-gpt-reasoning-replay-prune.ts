#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-gpt-reasoning-replay-prune.ts — FN-020 S3: the
//  GPT Responses lane can stop replaying PRIOR-turn encrypted reasoning —
//  behind a registered opt-in flag, default OFF (the wire is byte-identical
//  until the provider contract is verified live).
//
//  The class: the request is stateless (store:false, encrypted reasoning
//  included), and every historical assistant turn's persisted record
//  replays VERBATIM, reasoning items included — nothing prunes reasoning
//  from turns before the last user message, so the upload grows with every
//  settled turn (session-total waste quadratic). The chat-completions lanes
//  already ship the opposite policy (keepReasoningHistory defaults false).
//
//    P1  OFF (the default): the replay is byte-identical — every record item
//        rides, reasoning included, in order
//    P2  ON: the reasoning items of turns BEFORE the last user message are
//        dropped; the current turn's (after it) stay — the documented
//        intra-turn requirement; every other item and every position kept
//    P3  THE COUNT: bytes per request before and after, the census agrees
//    P4  wiring — the flag row is registered opt-in, the mapper reads it
//        per call, the prune keys on the last user message
//
//  Pure: the bridge's mapper over a fixture history; no request is sent.
//  The live A/B against the provider is the operator's — named, not run.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_GPT_PRUNE_PRIOR_REASONING

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const bridge = await import('../../src/services/providers/openai/responsesBridge.ts')
type BridgeMessage = import('../../src/services/providers/openai/responsesBridge.ts').BridgeMessage
type Item = import('../../src/services/providers/openai/openaiWire.ts').OpenaiInputItem

const reasoning = (id: string, size: number): Item => ({ type: 'reasoning', id, summary: [], content: [], encrypted_content: 'r'.repeat(size) })
const call = (id: string): Item => ({ type: 'function_call', call_id: `call_${id}`, name: 'Read', arguments: '{"path":"a.ts"}', id: `fc_${id}` })
const say = (text: string): Item => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const turn = (turnId: string, items: Item[]): BridgeMessage => ({ role: 'assistant', content: `(turn ${turnId})`, turnId, turnRecord: { provider: 'openai', items } })
const user = (text: string): BridgeMessage => ({ role: 'user', content: text })

// Three settled turns, then the current turn after the last user message —
// ONE record per turn (the mapper's law: one truth per turn), the current
// turn's record carrying two reasoning items across its tool loop.
const history: BridgeMessage[] = [
  user('first ask'),
  turn('t1', [reasoning('r1', 4000), call('1'), reasoning('r1b', 3000), say('done one')]),
  user('second ask'),
  turn('t2', [reasoning('r2', 5000), say('done two')]),
  user('third ask'),
  turn('t3', [reasoning('r3', 6000), call('3'), say('done three')]),
  user('the current ask'),
  turn('t4', [reasoning('r4', 2500), call('4'), reasoning('r4b', 1500), say('working…')]),
]
const bytes = (items: Item[]): number => Buffer.byteLength(JSON.stringify(items), 'utf8')
const reasoningIds = (items: Item[]): string[] => items.filter(i => i.type === 'reasoning').map(i => (i as { id?: string }).id ?? '?')

section('P1 OFF — the replay is byte-identical: every record item rides, in order')
const before = bridge.mapMessagesToOpenaiInput(history)
{
  const expectedRecordItems = history.flatMap(m => m.turnRecord?.items ?? [])
  const replayed = before.filter(i => i.type !== 'message' || (i as { role?: string }).role !== 'user')
  check('with the flag unset every record item replays verbatim, in order (reasoning included)', JSON.stringify(replayed) === JSON.stringify(expectedRecordItems), `${replayed.length} vs ${expectedRecordItems.length}`)
  check('all six reasoning items ride', reasoningIds(before).join(',') === 'r1,r1b,r2,r3,r4,r4b', reasoningIds(before).join(','))
  check('the user rows are in their positions', before.filter(i => i.type === 'message' && (i as { role?: string }).role === 'user').length === 4)
}

section('P2 ON — prior turns lose their reasoning; the current turn keeps its own')
process.env.MERCURY_GPT_PRUNE_PRIOR_REASONING = '1'
const census = bridge.replayPruneCensus
census.items = 0
census.bytes = 0
const after = bridge.mapMessagesToOpenaiInput(history)
delete process.env.MERCURY_GPT_PRUNE_PRIOR_REASONING
{
  const lastUser = before.map(i => i.type === 'message' && (i as { role?: string }).role === 'user').lastIndexOf(true)
  const expected = before.filter((i, idx) => !(idx < lastUser && i.type === 'reasoning'))
  check('the output is the OFF output minus the reasoning items that precede the last user message', JSON.stringify(after) === JSON.stringify(expected), `${after.length} vs ${expected.length}`)
  check('the current turn keeps both of its reasoning items (intra-turn continuation)', reasoningIds(after).join(',') === 'r4,r4b', reasoningIds(after).join(','))
  check('every function_call and message item survives, in order', after.filter(i => i.type !== 'reasoning').length === before.filter(i => i.type !== 'reasoning').length)
  const again = bridge.mapMessagesToOpenaiInput(history)
  check('with the flag unset again the replay is verbatim once more (per-call read, no latch)', JSON.stringify(again) === JSON.stringify(before))
}

section('P3 THE COUNT — bytes per request')
{
  const b = bytes(before)
  const a = bytes(after)
  // The census counts each pruned item's own serialization; the wire's
  // input ARRAY also sheds one separator per removed item, so the shed is
  // the census bytes plus one byte per item — by construction of JSON.
  check('the request shed exactly the pruned reasoning bytes plus one array separator per pruned item', b - a > 0 && census.items === 4 && b - a === census.bytes + census.items, `${b} → ${a}, census ${JSON.stringify(census)}`)
  console.log(`  BEFORE (flag off, today's wire): ${b} input bytes with 4 settled turns of reasoning replayed · AFTER (flag on): ${a} — ${b - a} bytes (${census.items} reasoning items) fewer on this request; the shed grows with every settled turn`)
}

section('P4 wiring')
{
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  check("the flag row is registered opt-in with a byte-identical off arm", /env: 'MERCURY_GPT_PRUNE_PRIOR_REASONING', kind: 'opt-in'/.test(registry))
  const src = readFileSync(join(ROOT, 'src/services/providers/openai/responsesBridge.ts'), 'utf8')
  check('the mapper reads the flag per call (the gate reader) and keys the prune on the last user message', /const prunePrior = flagEnabled\('MERCURY_GPT_PRUNE_PRIOR_REASONING'\)/.test(src) && /prunePrior && index < lastUserIndex/.test(src))
  check('only reasoning items are ever dropped, only from turns before the last user message', /item\.type !== 'reasoning'/.test(src))
}

console.log(failures === 0 ? '\n✅ ALL GPT-REASONING-REPLAY-PRUNE PROOFS PASS' : `\n❌ ${failures} GPT-REASONING-REPLAY-PRUNE PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
