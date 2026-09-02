#!/usr/bin/env bun
// ============================================================================
//  prove-content-shape-totality — the raw message-content DOOR is total.
//
//  The field crash this locks out (crash archive, origin
//  app-root): a session message whose `message.content` arrived as a plain
//  string (a provider dialect / persisted-transcript shape) reached
//  normalizeMessages' assistant arm, whose bare `content.map` threw inside
//  the whole-chat memo — above every row boundary — and ended the session.
//  The wire type says Array<ContentBlock>; the RUNTIME stream (resume,
//  foreign turns) can carry a string or worse, so every consumer of a RAW
//  (pre-normalize) message must be total over the shape.
//
//  The law: src/utils/messages/ has ONE shape owner, contentBlocksOf
//  (normalize.ts) — array passes through, string becomes one text block
//  (the wire's own equivalence), anything else degrades to zero blocks
//  (one corrupt record drops; the transcript lives). Raw-domain consumers
//  route through it or guard locally with Array.isArray; the inventory
//  below pins every direct method-call chain in the directory, so a NEW
//  unguarded consumer moves a count and reds this prover. To satisfy it:
//  route the read through contentBlocksOf, or guard it and update the
//  inventory row with the guard's line in the WHY column — never a bare
//  count bump.
//
//  §1 the shape owner exists and the door files carry zero direct chains
//  §2 runtime teeth: malformed shapes through the real functions — no throw,
//     exact degraded shapes, and the healthy behavior pinned unchanged
//  §3 the directory inventory: every direct chain adjudicated
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeMessages, isToolUseRequestMessage, isToolUseResultMessage, contentBlocksOf } from '../../src/utils/messages/normalize.js'
import { buildMessageLookups, buildSubagentLookups, getSiblingToolUseIDs } from '../../src/utils/messages/lookups.js'
import { ensureToolResultPairing, orderToolResultsByUse } from '../../src/utils/messages/pairing.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const DIR = join(import.meta.dir, '..', '..', 'src', 'utils', 'messages')

// ── §1 the shape owner + zero direct chains at the door ─────────────────────
{
  const normalizeSrc = readFileSync(join(DIR, 'normalize.ts'), 'utf8')
  t('§1 the shape owner is exported from normalize.ts', /export function contentBlocksOf\(/.test(normalizeSrc))
  t('§1 the owner handles the string shape (wire equivalence)', /typeof content === 'string'/.test(normalizeSrc))
  t('§1 the owner guards with Array.isArray', /Array\.isArray\(content\)/.test(normalizeSrc))
}

// The throwing shape: a method CALL chained straight onto `.message.content`
// (indexing is throw-safe on the malformed shapes; calls are not).
const CALL_CHAIN = /\.message\.content\s*\.\s*(map|some|every|filter|flatMap|find|findIndex|forEach|reduce|slice|includes|at|concat|indexOf|join)\s*\(/g
const FOR_OF_CHAIN = /for\s*\(\s*const\s+\w+\s+of\s+[\w.]*\.message\.content\s*\)/g

function chainCount(file: string): number {
  const src = readFileSync(join(DIR, file), 'utf8')
  return (src.match(CALL_CHAIN) ?? []).length + (src.match(FOR_OF_CHAIN) ?? []).length
}

// ── §3 the directory inventory (adjudicated) ─────────────────────
// file → [count, why the remaining chains are lawful]
const INVENTORY: Record<string, [number, string]> = {
  'normalize.ts': [0, 'the door — every read routes through contentBlocksOf'],
  'lookups.ts': [1, 'one .some in buildMessageLookups\'s user pass, under its own Array.isArray guard; every raw walk routes through the owner'],
  'apiView.ts': [2, 'two chains in model post-processing that run AFTER normalizeMessagesForAPI, whose assistant arm coerces through the owner — array by construction'],
  'pairing.ts': [5, 'five chains each under an Array.isArray predicate or guard on the adjacent line; the raw walks route through the owner'],
  'streaming.ts': [1, 'one .find over the stream assembler\'s own self-minted block array — never a foreign shape'],
  'systemMessages.ts': [4, 'four chains each under an Array.isArray guard on the previous line'],
}

{
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.ts'))) {
    const n = chainCount(file)
    const row = INVENTORY[file]
    if (row === undefined) {
      t(`§3 ${file} carries no direct content call-chains`, n === 0, n === 0 ? '' : `${n} chain(s) — route through contentBlocksOf or guard + inventory`)
    } else {
      t(`§3 ${file} inventory holds (${row[0]}: ${row[1]})`, n === row[0], n === row[0] ? '' : `found ${n}, inventoried ${row[0]}`)
    }
  }
}

// ── §2 runtime teeth ────────────────────────────────────────────────────────
type AnyMessage = Parameters<typeof normalizeMessages>[0][number]
const mk = (over: object): AnyMessage => over as AnyMessage

const STRING_ASSISTANT = mk({
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000001',
  timestamp: '2026-08-31T00:00:00.000Z',
  message: { id: 'msg_poison_1', role: 'assistant', content: 'plain words from a foreign turn', model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
})
const OBJECT_ASSISTANT = mk({
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000002',
  timestamp: '2026-08-31T00:00:00.000Z',
  message: { id: 'msg_poison_2', role: 'assistant', content: { rich: 'nonsense' }, model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
})
const STRING_USER = mk({
  type: 'user',
  uuid: '00000000-0000-4000-8000-000000000003',
  timestamp: '2026-08-31T00:00:00.000Z',
  message: { role: 'user', content: 'typed words' },
})
const OBJECT_USER = mk({
  type: 'user',
  uuid: '00000000-0000-4000-8000-000000000004',
  timestamp: '2026-08-31T00:00:00.000Z',
  message: { role: 'user', content: { not: 'blocks' } },
})
const HEALTHY_TWO_BLOCK = mk({
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000005',
  timestamp: '2026-08-31T00:00:00.000Z',
  message: { id: 'msg_ok', role: 'assistant', content: [ { type: 'text', text: 'a' }, { type: 'text', text: 'b' } ], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
})

// the owner itself
{
  t('§2 owner: array passes through by reference', (() => { const a = [{ type: 'text', text: 'x' }]; return contentBlocksOf(a) === a })())
  const s = contentBlocksOf('hello')
  t('§2 owner: string becomes one text block', s.length === 1 && s[0]?.type === 'text' && (s[0] as { text?: string }).text === 'hello')
  t('§2 owner: other shapes degrade to zero blocks', contentBlocksOf({ x: 1 }).length === 0 && contentBlocksOf(undefined).length === 0 && contentBlocksOf(null).length === 0 && contentBlocksOf(7).length === 0)
}

// the render door
{
  let rows: ReturnType<typeof normalizeMessages> | null = null
  let threw = ''
  try { rows = normalizeMessages([STRING_ASSISTANT]) } catch (e) { threw = String(e) }
  t('§2 door: string-content assistant renders without throwing', threw === '', threw)
  t('§2 door: …as one text row carrying the words', rows !== null && rows.length === 1 && (rows[0] as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content?.[0]?.type === 'text' && (rows[0] as { message: { content: Array<{ text?: string }> } }).message.content[0]?.text === 'plain words from a foreign turn')

  threw = ''
  let objRows: ReturnType<typeof normalizeMessages> | null = null
  try { objRows = normalizeMessages([OBJECT_ASSISTANT]) } catch (e) { threw = String(e) }
  t('§2 door: object-content assistant drops that record only', threw === '' && objRows !== null && objRows.length === 0, threw)

  threw = ''
  let userRows: ReturnType<typeof normalizeMessages> | null = null
  try { userRows = normalizeMessages([STRING_USER]) } catch (e) { threw = String(e) }
  t('§2 door: string-content user still coerces to one text row (standing behavior)', threw === '' && userRows !== null && userRows.length === 1)

  threw = ''
  let objUserRows: ReturnType<typeof normalizeMessages> | null = null
  try { objUserRows = normalizeMessages([OBJECT_USER]) } catch (e) { threw = String(e) }
  t('§2 door: object-content user drops that record only', threw === '' && objUserRows !== null && objUserRows.length === 0, threw)

  const healthy = normalizeMessages([HEALTHY_TWO_BLOCK])
  t('§2 door: healthy multi-block split unchanged (two rows, derived uuids)', healthy.length === 2 && healthy[0]?.uuid !== healthy[1]?.uuid && (healthy[0] as { message: { content: unknown[] } }).message.content.length === 1)
  const again = normalizeMessages([HEALTHY_TWO_BLOCK])
  t('§2 door: the per-message row cache still returns identical rows', again[0] === healthy[0] && again[1] === healthy[1])
}

// the type guards
{
  let threw = ''
  let a = false
  let b = false
  try { a = isToolUseRequestMessage(STRING_ASSISTANT); b = isToolUseResultMessage(STRING_USER) } catch (e) { threw = String(e) }
  t('§2 guards: tool-use/tool-result discriminators answer false on malformed shapes, never throw', threw === '' && a === false && b === false, threw)
}

// the sibling lookup over the same raw stream
{
  const TOOL_ROW = mk({
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000006',
    timestamp: '2026-08-31T00:00:00.000Z',
    message: { id: 'msg_tu', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  })
  const normalizedTool = normalizeMessages([TOOL_ROW])[0]
  let threw = ''
  let siblings: Set<string> | null = null
  try {
    siblings = getSiblingToolUseIDs(normalizedTool as Parameters<typeof getSiblingToolUseIDs>[0], [STRING_ASSISTANT, TOOL_ROW])
  } catch (e) { threw = String(e) }
  t('§2 lookups: sibling walk survives a poisoned raw row beside the real one', threw === '' && siblings !== null && siblings.has('tu_1'), threw)
}

// the wire healer over the same raw stream
{
  let threw = ''
  let healed: ReturnType<typeof ensureToolResultPairing> | null = null
  try { healed = ensureToolResultPairing([STRING_ASSISTANT, STRING_USER] as Parameters<typeof ensureToolResultPairing>[0]) } catch (e) { threw = String(e) }
  t('§2 pairing: the wire healer survives poisoned raw rows', threw === '', threw)
  t('§2 pairing: …and keeps the string-content turn (coerced, never dropped)', healed !== null && healed.length === 2)

  threw = ''
  try { orderToolResultsByUse([OBJECT_ASSISTANT, STRING_USER] as Parameters<typeof orderToolResultsByUse>[0]) } catch (e) { threw = String(e) }
  t('§2 pairing: the result-ordering walk survives poisoned raw rows', threw === '', threw)
}

// the lookup builders over poisoned raw + subagent streams
{
  let threw = ''
  try {
    buildMessageLookups([], [OBJECT_ASSISTANT, STRING_ASSISTANT, STRING_USER] as Parameters<typeof buildMessageLookups>[1])
  } catch (e) { threw = String(e) }
  t('§2 lookups: buildMessageLookups raw pass survives poisoned rows', threw === '', threw)

  threw = ''
  try {
    buildSubagentLookups([{ message: OBJECT_ASSISTANT }, { message: STRING_ASSISTANT }] as unknown as Parameters<typeof buildSubagentLookups>[0])
  } catch (e) { threw = String(e) }
  t('§2 lookups: buildSubagentLookups survives poisoned subagent rows', threw === '', threw)
}

console.log(failures === 0 ? 'CONTENT-SHAPE TOTALITY: ALL PASS' : 'CONTENT-SHAPE TOTALITY: RED')
process.exit(failures)
