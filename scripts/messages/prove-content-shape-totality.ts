#!/usr/bin/env bun
import { normalizeMessages, isToolUseRequestMessage, isToolUseResultMessage, contentBlocksOf } from '../../src/utils/messages/normalize.js'
import { buildMessageLookups, buildSubagentLookups, getSiblingToolUseIDs } from '../../src/utils/messages/lookups.js'
import { ensureToolResultPairing, orderToolResultsByUse } from '../../src/utils/messages/pairing.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
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
  t('§2 owner: array passes through by reference', (() => { const a = [{ type: 'text', text: 'x' }]; return contentBlocksOf(a) === a })())
  const s = contentBlocksOf('hello')
  t('§2 owner: string becomes one text block', s.length === 1 && s[0]?.type === 'text' && (s[0] as { text?: string }).text === 'hello')
  t('§2 owner: other shapes degrade to zero blocks', contentBlocksOf({ x: 1 }).length === 0 && contentBlocksOf(undefined).length === 0 && contentBlocksOf(null).length === 0 && contentBlocksOf(7).length === 0)
}

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

{
  let threw = ''
  let a = false
  let b = false
  try { a = isToolUseRequestMessage(STRING_ASSISTANT); b = isToolUseResultMessage(STRING_USER) } catch (e) { threw = String(e) }
  t('§2 guards: tool-use/tool-result discriminators answer false on malformed shapes, never throw', threw === '' && a === false && b === false, threw)
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
  t('§2 lookups: sibling walk survives a poisoned raw row beside the real one', threw === '' && siblings !== null && siblings.has('tu_1'), threw)
}

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
