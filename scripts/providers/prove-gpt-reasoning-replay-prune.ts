#!/usr/bin/env bun
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

const bridge = await import('../../src/models/roads/openai/responsesBridge.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
type BridgeMessage = import('../../src/models/roads/openai/responsesBridge.ts').BridgeMessage
type Item = import('../../src/models/roads/openai/openaiWire.ts').OpenaiInputItem

const reasoning = (id: string, size: number): Item => ({ type: 'reasoning', id, summary: [], content: [], encrypted_content: 'r'.repeat(size) })
const call = (id: string): Item => ({ type: 'function_call', call_id: `call_${id}`, name: 'Read', arguments: '{"path":"a.ts"}', id: `fc_${id}` })
const say = (text: string): Item => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const turn = (turnId: string, items: Item[]): BridgeMessage => ({ role: 'assistant', content: `(turn ${turnId})`, turnId, turnRecord: { provider: 'openai', items } })
const user = (text: string): BridgeMessage => ({ role: 'user', content: text })

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
  check('with the flag unset every record item replays verbatim, in order (reasoning included)', JSON.stringify(replayed) === JSON.stringify(expectedRecordItems), `${replayed.length} vs ${expectedRecordItems.length}; mapMessagesToOpenaiInput in src/models/roads/openai/responsesBridge.ts must replay every turnRecord item untouched while MERCURY_GPT_PRUNE_PRIOR_REASONING is unset`)
  check('all six reasoning items ride', reasoningIds(before).join(',') === 'r1,r1b,r2,r3,r4,r4b', reasoningIds(before).join(',') + '; mapMessagesToOpenaiInput in src/models/roads/openai/responsesBridge.ts must keep all reasoning items with the flag unset')
  check('the user rows are in their positions', before.filter(i => i.type === 'message' && (i as { role?: string }).role === 'user').length === 4, 'mapMessagesToOpenaiInput in src/models/roads/openai/responsesBridge.ts must keep the four user rows in place')
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
  check('the output is the OFF output minus the reasoning items that precede the last user message', JSON.stringify(after) === JSON.stringify(expected), `${after.length} vs ${expected.length}; with MERCURY_GPT_PRUNE_PRIOR_REASONING on, mapMessagesToOpenaiInput in src/models/roads/openai/responsesBridge.ts must drop only the reasoning items before the last user message`)
  check('the current turn keeps both of its reasoning items (intra-turn continuation)', reasoningIds(after).join(',') === 'r4,r4b', reasoningIds(after).join(',') + '; the prune in mapMessagesToOpenaiInput (src/models/roads/openai/responsesBridge.ts) must keep reasoning after the last user message')
  check('every function_call and message item survives, in order', after.filter(i => i.type !== 'reasoning').length === before.filter(i => i.type !== 'reasoning').length, 'the prune in mapMessagesToOpenaiInput (src/models/roads/openai/responsesBridge.ts) must drop reasoning items only')
  const again = bridge.mapMessagesToOpenaiInput(history)
  check('with the flag unset again the replay is verbatim once more (per-call read, no latch)', JSON.stringify(again) === JSON.stringify(before), 'mapMessagesToOpenaiInput in src/models/roads/openai/responsesBridge.ts must read the flag on every call, not latch it')
}

section('P3 THE COUNT — bytes per request')
{
  const b = bytes(before)
  const a = bytes(after)
  check('the request shed exactly the pruned reasoning bytes plus one array separator per pruned item', b - a > 0 && census.items === 4 && b - a === census.bytes + census.items, `${b} → ${a}, census ${JSON.stringify(census)}; replayPruneCensus in src/models/roads/openai/responsesBridge.ts must count each pruned reasoning item and its bytes`)
  console.log(`  BEFORE (flag off, today's wire): ${b} input bytes with 4 settled turns of reasoning replayed · AFTER (flag on): ${a} — ${b - a} bytes (${census.items} reasoning items) fewer on this request; the shed grows with every settled turn`)
}

section('P4 wiring')
{
  check("the flag row is registered opt-in with a byte-identical off arm", getFlagSpec('MERCURY_GPT_PRUNE_PRIOR_REASONING')?.kind === 'opt-in', 'MERCURY_GPT_PRUNE_PRIOR_REASONING must be registered as an opt-in flag in FLAG_REGISTRY')
}

console.log(failures === 0 ? '\n✅ ALL GPT-REASONING-REPLAY-PRUNE PROOFS PASS' : `\n❌ ${failures} GPT-REASONING-REPLAY-PRUNE PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
