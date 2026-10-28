#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'
import type { CompatChatRequest } from '../../src/services/providers/openaicompat/compatChatClient.ts'
import type { GeminiContent, GeminiPart } from '../../src/services/providers/gemini/geminiCodec.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { buildGeminiRequest, geminiThoughtKindOf, GEMINI_SKIP_SIGNATURE_VALIDATION } = await import('../../src/services/providers/gemini/geminiCodec.ts')

let passes = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const CLAUDE = 'claude-opus-5-5-high'
const GEMINI = 'gemini-4-argon'

function varint(value: number): number[] {
  const out: number[] = []
  let left = value
  while (left >= 0x80) {
    out.push((left & 0x7f) | 0x80)
    left = Math.floor(left / 128)
  }
  out.push(left)
  return out
}
const field = (index: number, wire: number): number[] => varint((index << 3) | wire)
const bytesField = (index: number, bytes: number[]): number[] => [...field(index, 2), ...varint(bytes.length), ...bytes]
const varintField = (index: number, value: number): number[] => [...field(index, 0), ...varint(value)]
const text = (value: string): number[] => [...Buffer.from(value, 'utf8')]

function envelope(kind: string, layers: 1 | 2 = 2): string {
  const meta = [...varintField(1, 19), ...varintField(2, 2), ...varintField(3, 2), ...varintField(7, 1), ...bytesField(8, text(kind))]
  const inner = [...bytesField(1, meta), ...bytesField(2, Array.from({ length: 12 }, (_, i) => i + 1)), ...bytesField(5, Array.from({ length: 40 }, (_, i) => (i * 7) % 251))]
  const proto = [...varintField(1, 4), ...bytesField(2, inner), ...varintField(3, 1)]
  const once = Buffer.from(proto).toString('base64')
  return layers === 1 ? once : Buffer.from(once, 'ascii').toString('base64')
}

const assistantRecord = (model: string, parts: GeminiPart[], calls: Array<{ id: string; name: string; nativeId?: string }>, row: unknown): Message =>
  ({ type: 'assistant', uuid: randomUUID(), timestamp: '', message: { role: 'assistant', content: [] }, geminiProviderTurn: { model, parts, calls, projection: JSON.stringify(row) } }) as never

const assistantPlain = (): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: '', message: { role: 'assistant', content: [] } }) as never

function modelContents(request: { contents: GeminiContent[] }): GeminiContent[] {
  return request.contents.filter(content => content.role === 'model')
}
function responses(request: { contents: GeminiContent[] }): GeminiPart[] {
  return request.contents.flatMap(content => content.parts.filter(part => part.functionResponse !== undefined))
}

console.log('── (a) a history minted on the direct Anthropic road (tool_use + result), replayed on the Gemini plan road for a Claude row ──')
{
  const anthropicRows: CompatChatRequest['messages'] = [
    { role: 'user', content: 'Read the handoff.' },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_01QMM8mNnkLXu5fwDTENY26J', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/h.md"}' } }, { id: 'toolu_017CtYqqknpcJgh6YazKb9nT', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_01QMM8mNnkLXu5fwDTENY26J', content: 'the handoff' },
    { role: 'tool', tool_call_id: 'toolu_017CtYqqknpcJgh6YazKb9nT', content: 'a b' },
    { role: 'user', content: 'Go on.' },
  ]
  const request = buildGeminiRequest({ model: CLAUDE, messages: anthropicRows } as never, [assistantPlain()])
  const calls = modelContents(request).flatMap(content => content.parts.filter(part => part.functionCall !== undefined))
  check('every function call carries its id (the Anthropic tool_use id, which the wire allows as it is)', calls.length === 2 && calls[0]!.functionCall?.id === 'toolu_01QMM8mNnkLXu5fwDTENY26J' && calls[1]!.functionCall?.id === 'toolu_017CtYqqknpcJgh6YazKb9nT', JSON.stringify(calls))
  check('every function response carries the matching id', JSON.stringify(responses(request).map(part => part.functionResponse?.id)) === JSON.stringify(['toolu_01QMM8mNnkLXu5fwDTENY26J', 'toolu_017CtYqqknpcJgh6YazKb9nT']), JSON.stringify(responses(request)))
  check('no placeholder signature rides a Claude row', calls.every(part => part.thoughtSignature === undefined))

  const otherRoad = buildGeminiRequest({ model: CLAUDE, messages: anthropicRows.slice(0, 4) } as never, [assistantRecord(GEMINI, [{ functionCall: { name: 'Read', args: {} }, thoughtSignature: 'sig-argon' }], [{ id: 'toolu_01QMM8mNnkLXu5fwDTENY26J', name: 'Read' }], anthropicRows[1])])
  const otherCalls = modelContents(otherRoad).flatMap(content => content.parts.filter(part => part.functionCall !== undefined))
  check('a record another model wrote is rebuilt with ids, never replayed', otherCalls.length === 2 && otherCalls.every(part => typeof part.functionCall?.id === 'string' && part.functionCall.id.length > 0 && part.thoughtSignature === undefined), JSON.stringify(otherCalls))

  const odd: CompatChatRequest['messages'] = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call:7|x.y', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call:7|x.y', content: 'ok' },
  ]
  const sanitised = buildGeminiRequest({ model: CLAUDE, messages: odd } as never, [assistantPlain()])
  const oddCall = modelContents(sanitised)[0]?.parts[0]?.functionCall
  check('an id from another road is restricted to the characters Anthropic allows, the same on the call and its response', oddCall?.id === 'call_7_x_y' && responses(sanitised)[0]?.functionResponse?.id === 'call_7_x_y', JSON.stringify({ call: oddCall, responses: responses(sanitised) }))
}

console.log('── (b) a Claude record with thought parts: unsigned ones and a narration-kind one are dropped, the thinking-kind one stays ──')
{
  const row = { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] }
  const thinking = envelope('thinking')
  const narration = envelope('narration')
  check('the envelope reader names the kind through both base64 layers', geminiThoughtKindOf(thinking) === 'thinking' && geminiThoughtKindOf(narration) === 'narration' && geminiThoughtKindOf(envelope('thinking', 1)) === 'thinking', JSON.stringify([geminiThoughtKindOf(thinking), geminiThoughtKindOf(narration)]))
  check('a signature that is not an envelope names no kind', geminiThoughtKindOf('sig-1-a') === null && geminiThoughtKindOf('') === null && geminiThoughtKindOf(GEMINI_SKIP_SIGNATURE_VALIDATION) === null)
  const record = assistantRecord(CLAUDE, [
    { text: 'first thought', thought: true, thoughtSignature: thinking },
    { text: 'the narration', thought: true, thoughtSignature: narration },
    { text: 'a thought that never got its signature', thought: true },
    { text: 'Running it.' },
    { functionCall: { name: 'Bash', args: { command: 'pwd' }, id: 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd' } },
  ], [{ id: 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd', name: 'Bash', nativeId: 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd' }], row)
  const request = buildGeminiRequest({ model: CLAUDE, messages: [{ role: 'user', content: 'x' }, row, { role: 'tool', tool_call_id: 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd', content: '/tmp' }] } as never, [record])
  const parts = modelContents(request)[0]?.parts ?? []
  check('the replayed turn keeps the signed thinking part, the text and the call, and nothing else', JSON.stringify(parts.map(part => [part.thought === true, part.text ?? part.functionCall?.name, part.thoughtSignature === thinking])) === JSON.stringify([[true, 'first thought', true], [false, 'Running it.', false], [false, 'Bash', false]]), JSON.stringify(parts))
  check('the call and its response keep the id Google gave them', parts.at(-1)?.functionCall?.id === 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd' && responses(request)[0]?.functionResponse?.id === 'toolu_vrtx_01B9s3ewQspRGZYU45QfMoXd')

  const thoughtOnly = assistantRecord(CLAUDE, [{ text: 'only an unsigned thought', thought: true }], [], { role: 'assistant', content: '' })
  const emptied = buildGeminiRequest({ model: CLAUDE, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '' }, { role: 'user', content: 'y' }] } as never, [thoughtOnly])
  check('a turn left with no part is not sent as an empty message', emptied.contents.every(content => content.parts.length > 0) && emptied.contents.length === 1 && emptied.contents[0]!.parts.length === 2, JSON.stringify(emptied.contents))

  const unIdd = assistantRecord(CLAUDE, [{ functionCall: { name: 'Bash', args: {} } }], [{ id: 'toolu_01NoNative', name: 'Bash' }], { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01NoNative', type: 'function', function: { name: 'Bash', arguments: '{}' } }] })
  const filled = buildGeminiRequest({ model: CLAUDE, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01NoNative', type: 'function', function: { name: 'Bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'toolu_01NoNative', content: 'ok' }] } as never, [unIdd])
  check('a replayed call Google left unnamed takes the call id on the call and its response', modelContents(filled)[0]?.parts[0]?.functionCall?.id === 'toolu_01NoNative' && responses(filled)[0]?.functionResponse?.id === 'toolu_01NoNative', JSON.stringify(filled.contents))
}

console.log('── (c) a Gemini row is byte-identical to before: no id, the placeholder, every thought part as recorded ──')
{
  const row = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }
  const messages = [{ role: 'user', content: 'x' }, row, { role: 'tool', tool_call_id: 'c1', content: 'ok' }]
  const rebuilt = buildGeminiRequest({ model: GEMINI, messages } as never, [assistantPlain()])
  check('the rebuild branch on a Gemini row: no id, the documented placeholder on the first call, the response unnamed', JSON.stringify(rebuilt.contents) === JSON.stringify([
    { role: 'user', parts: [{ text: 'x' }] },
    { role: 'model', parts: [{ functionCall: { name: 'Bash', args: { command: 'ls' } }, thoughtSignature: GEMINI_SKIP_SIGNATURE_VALIDATION }] },
    { role: 'user', parts: [{ functionResponse: { name: 'Bash', response: { output: 'ok' } } }] },
  ]), JSON.stringify(rebuilt.contents))
  const recorded = assistantRecord(GEMINI, [{ text: 'a thought', thought: true }, { text: 'a narration-shaped thought', thought: true, thoughtSignature: envelope('narration') }, { functionCall: { name: 'Bash', args: { command: 'ls' } } }], [{ id: 'c1', name: 'Bash' }], row)
  const replayed = buildGeminiRequest({ model: GEMINI, messages } as never, [recorded])
  check('the replay branch on a Gemini row sends the record as it stands', JSON.stringify(replayed.contents[1]) === JSON.stringify({ role: 'model', parts: [{ text: 'a thought', thought: true }, { text: 'a narration-shaped thought', thought: true, thoughtSignature: envelope('narration') }, { functionCall: { name: 'Bash', args: { command: 'ls' } } }] }) && JSON.stringify(replayed.contents[2]) === JSON.stringify({ role: 'user', parts: [{ functionResponse: { name: 'Bash', response: { output: 'ok' } } }] }), JSON.stringify(replayed.contents))
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
