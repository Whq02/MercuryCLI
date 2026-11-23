#!/usr/bin/env bun
import { normalizeMessages, isToolUseRequestMessage, isToolUseResultMessage, contentBlocksOf } from '../../src/engine/message-shapes/normalize.js'
import { buildMessageLookups, buildSubagentLookups, getSiblingToolUseIDs } from '../../src/engine/messages/lookups.js'
import { ensureToolResultPairing, orderToolResultsByUse } from '../../src/engine/messages/wirePairing.js'

let failures = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) failures = 1
}



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

{
  t('§2 owner: array passes through by reference', (() => { const a = [{ type: 'text', text: 'x' }]; return contentBlocksOf(a) === a })(), '', 'contentBlocksOf in src/engine/message-shapes/normalize.ts must return an array argument unchanged, same reference')
  const s = contentBlocksOf('hello')
  t('§2 owner: string becomes one text block', s.length === 1 && s[0]?.type === 'text' && (s[0] as { text?: string }).text === 'hello', '', 'contentBlocksOf in src/engine/message-shapes/normalize.ts must turn a string into one text block')
  t('§2 owner: other shapes degrade to zero blocks', contentBlocksOf({ x: 1 }).length === 0 && contentBlocksOf(undefined).length === 0 && contentBlocksOf(null).length === 0 && contentBlocksOf(7).length === 0, '', 'contentBlocksOf in src/engine/message-shapes/normalize.ts must return zero blocks for an object, undefined, null or a number')
}

{
  let rows: ReturnType<typeof normalizeMessages> | null = null
  let threw = ''
  try { rows = normalizeMessages([STRING_ASSISTANT]) } catch (e) { threw = String(e) }
  t('§2 door: string-content assistant renders without throwing', threw === '', threw, 'normalizeMessages in src/engine/message-shapes/normalize.ts must read string content through contentBlocksOf and not throw')
  t('§2 door: …as one text row carrying the words', rows !== null && rows.length === 1 && (rows[0] as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content?.[0]?.type === 'text' && (rows[0] as { message: { content: Array<{ text?: string }> } }).message.content[0]?.text === 'plain words from a foreign turn', '', 'normalizeMessages in src/engine/message-shapes/normalize.ts must emit one text row carrying a string-content assistant message')

  threw = ''
  let objRows: ReturnType<typeof normalizeMessages> | null = null
  try { objRows = normalizeMessages([OBJECT_ASSISTANT]) } catch (e) { threw = String(e) }
  t('§2 door: object-content assistant drops that record only', threw === '' && objRows !== null && objRows.length === 0, threw, 'normalizeMessages in src/engine/message-shapes/normalize.ts must drop an object-content assistant record and keep going without throwing')

  threw = ''
  let userRows: ReturnType<typeof normalizeMessages> | null = null
  try { userRows = normalizeMessages([STRING_USER]) } catch (e) { threw = String(e) }
  t('§2 door: string-content user still coerces to one text row (standing behavior)', threw === '' && userRows !== null && userRows.length === 1, threw, 'normalizeMessages in src/engine/message-shapes/normalize.ts must coerce string user content into one text row')

  threw = ''
  let objUserRows: ReturnType<typeof normalizeMessages> | null = null
  try { objUserRows = normalizeMessages([OBJECT_USER]) } catch (e) { threw = String(e) }
  t('§2 door: object-content user drops that record only', threw === '' && objUserRows !== null && objUserRows.length === 0, threw, 'normalizeMessages in src/engine/message-shapes/normalize.ts must drop an object-content user record and keep going without throwing')

  const healthy = normalizeMessages([HEALTHY_TWO_BLOCK])
  t('§2 door: healthy multi-block split unchanged (two rows, derived uuids)', healthy.length === 2 && healthy[0]?.uuid !== healthy[1]?.uuid && (healthy[0] as { message: { content: unknown[] } }).message.content.length === 1, '', 'normalizeMessages in src/engine/message-shapes/normalize.ts must still split a two-block message into two rows with different derived uuids')
  const again = normalizeMessages([HEALTHY_TWO_BLOCK])
  t('§2 door: the per-message row cache still returns identical rows', again[0] === healthy[0] && again[1] === healthy[1], '', 'normalizeMessages in src/engine/message-shapes/normalize.ts must return the cached rows for the same message object')
}

{
  let threw = ''
  let a = false
  let b = false
  try { a = isToolUseRequestMessage(STRING_ASSISTANT); b = isToolUseResultMessage(STRING_USER) } catch (e) { threw = String(e) }
  t('§2 guards: tool-use/tool-result discriminators answer false on malformed shapes, never throw', threw === '' && a === false && b === false, threw, 'isToolUseRequestMessage and isToolUseResultMessage in src/engine/message-shapes/normalize.ts must return false, not throw, on string-content rows')
}

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
  t('§2 lookups: sibling walk survives a poisoned raw row beside the real one', threw === '' && siblings !== null && siblings.has('tu_1'), threw, 'getSiblingToolUseIDs in src/engine/messages/lookups.ts must skip malformed raw rows and still find tu_1')
}

{
  let threw = ''
  let healed: ReturnType<typeof ensureToolResultPairing> | null = null
  try { healed = ensureToolResultPairing([STRING_ASSISTANT, STRING_USER] as Parameters<typeof ensureToolResultPairing>[0]) } catch (e) { threw = String(e) }
  t('§2 pairing: the wire healer survives poisoned raw rows', threw === '', threw, 'ensureToolResultPairing in src/engine/messages/wirePairing.ts must not throw on string-content rows')
  t('§2 pairing: …and keeps the string-content turn (coerced, never dropped)', healed !== null && healed.length === 2, '', 'ensureToolResultPairing in src/engine/messages/wirePairing.ts must keep both the string-content assistant and user rows')

  threw = ''
  try { orderToolResultsByUse([OBJECT_ASSISTANT, STRING_USER] as Parameters<typeof orderToolResultsByUse>[0]) } catch (e) { threw = String(e) }
  t('§2 pairing: the result-ordering walk survives poisoned raw rows', threw === '', threw, 'orderToolResultsByUse in src/engine/messages/wirePairing.ts must not throw on object or string content rows')
}

{
  let threw = ''
  try {
    buildMessageLookups([], [OBJECT_ASSISTANT, STRING_ASSISTANT, STRING_USER] as Parameters<typeof buildMessageLookups>[1])
  } catch (e) { threw = String(e) }
  t('§2 lookups: buildMessageLookups raw pass survives poisoned rows', threw === '', threw, 'buildMessageLookups in src/engine/messages/lookups.ts must not throw when the raw rows hold string or object content')

  threw = ''
  try {
    buildSubagentLookups([{ message: OBJECT_ASSISTANT }, { message: STRING_ASSISTANT }] as unknown as Parameters<typeof buildSubagentLookups>[0])
  } catch (e) { threw = String(e) }
  t('§2 lookups: buildSubagentLookups survives poisoned subagent rows', threw === '', threw, 'buildSubagentLookups in src/engine/messages/lookups.ts must not throw when subagent messages hold string or object content')
}

console.log(failures === 0 ? 'CONTENT-SHAPE TOTALITY: ALL PASS' : 'CONTENT-SHAPE TOTALITY: RED')
process.exit(failures)
