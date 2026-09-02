#!/usr/bin/env bun
import {
  buildOpenaiResponsesRequest,
  decodeOpenaiTurnRecord,
  mapMessagesToOpenaiInput,
  mapToolsToOpenai,
  type BridgeMessage,
} from '../../src/services/providers/openai/responsesBridge.js'
import {
  mapMessagesToZai,
  mapToolsToZai,
  type ApiShapedTool,
} from '../../src/services/providers/zai/zaiCodec.js'
import type { MessageParam } from '../../src/types/wire.js'
import { toOpenaiStrictSchema } from '../../src/utils/messages/structuredOutputDialect.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[k])
    }
    Object.freeze(v)
  }
  return v
}

section('§A B05 — turn-record receipts are defensive-total')
{
  const valid = {
    provider: 'openai',
    responseId: 'resp_1',
    items: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'thought' }],
        encrypted_content: 'ENC',
      },
      { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
  }
  const decoded = decodeOpenaiTurnRecord(valid)
  check('a valid record decodes', decoded !== undefined)
  check('items replay VERBATIM in true order', JSON.stringify(decoded?.items) === JSON.stringify(valid.items))
  check('the response id rides the receipt', decoded?.responseId === 'resp_1')

  check('a non-object is the typed missing path', decodeOpenaiTurnRecord('junk') === undefined)
  check('a foreign provider is the typed missing path', decodeOpenaiTurnRecord({ provider: 'zai', items: [{ type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' }] }) === undefined)
  check('an empty item list is the typed missing path', decodeOpenaiTurnRecord({ provider: 'openai', items: [] }) === undefined)

  const halfBroken = {
    provider: 'openai',
    items: [
      { type: 'function_call'  },
      { type: 'function_call', call_id: 'call_ok', name: 'Read', arguments: '{}' },
      { type: 'mystery_item_kind', payload: 1 },
    ],
  }
  const partial = decodeOpenaiTurnRecord(halfBroken)
  check('half-broken records drop ONLY the broken items', partial?.items.length === 1)
  check(
    'the surviving item is intact',
    partial?.items[0]?.type === 'function_call' &&
      (partial.items[0] as { call_id?: string }).call_id === 'call_ok',
  )
}

section('§B B06 — provider switch: explicit decisions, canonical history unmutated')
{
  const history: MessageParam[] = deepFreeze([
    { role: 'user' as const, content: 'hello' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'thinking' as const, thinking: 'private chain', signature: 'sig' },
        { type: 'text' as const, text: 'I will read the file.' },
        { type: 'tool_use' as const, id: 'toolu_1', name: 'Read', input: { path: '/tmp/x' } },
      ],
    },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result' as const, tool_use_id: 'toolu_1', content: 'file body' },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' },
        },
        { type: 'server_tool_use' as const, id: 'srv_1', name: 'web_search', input: {} },
      ],
    },
  ])

  const bridgeRows: BridgeMessage[] = history.map(m => ({ role: m.role, content: m.content }))
  const openai = mapMessagesToOpenaiInput(bridgeRows, { imagesSupported: false })
  const openaiJson = JSON.stringify(openai)
  check('openai: thinking NEVER round-trips', !openaiJson.includes('private chain'))
  check('openai: tool_use → function_call under the provider call id', openaiJson.includes('"call_id":"toolu_1"'))
  check('openai: unsupported image degrades to a VISIBLE marker', openaiJson.includes('[image]'))
  check('openai: unknown block type degrades to its type marker', openaiJson.includes('[server_tool_use]'))

  const zai = mapMessagesToZai('sys', history)
  const zaiJson = JSON.stringify(zai)
  check('zai: thinking NEVER round-trips', !zaiJson.includes('private chain'))
  check('zai: tool_result → role:tool under the call id', zaiJson.includes('"tool_call_id":"toolu_1"'))
  check('zai: unknown block types degrade to type markers', zaiJson.includes('[image]') && zaiJson.includes('[server_tool_use]'))

  check('canonical history object survives both mappings unmutated (deep-frozen)', true)
}

section('§C B08 — structured output rides the Responses wire (format parity)')
{
  const schema = { type: 'object', properties: { verdict: { type: 'string' } } }
  const req = buildOpenaiResponsesRequest({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'judge' }],
    outputFormat: { type: 'json_schema', schema },
  })
  check('text.format is the documented json_schema block', req.text?.format?.type === 'json_schema')
  check(
    'the wire schema is the strict-dialect derivation of the one truth',
    JSON.stringify(req.text?.format?.schema) === JSON.stringify(toOpenaiStrictSchema(schema)),
  )
  check('the caller schema object is never mutated', !('required' in schema))
  check('the format block carries a name', typeof req.text?.format?.name === 'string' && req.text.format.name.length > 0)

  const bare = buildOpenaiResponsesRequest({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'plain' }],
  })
  check('absent outputFormat omits the text key', !('text' in bare))
}

section('§D B08 — one tool-schema truth, two wire spellings')
{
  const tool: ApiShapedTool = {
    name: 'Bash',
    description: 'run a command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } } },
  }
  const flat = mapToolsToOpenai([tool])
  const nested = mapToolsToZai([tool])
  check('Responses spelling is FLAT', flat[0]?.type === 'function' && flat[0]?.name === 'Bash')
  check('Z.AI spelling is NESTED', nested[0]?.type === 'function' && nested[0]?.function.name === 'Bash')
  check(
    'both carry the IDENTICAL input_schema object',
    flat[0]?.parameters === tool.input_schema && nested[0]?.function.parameters === tool.input_schema,
  )
}

console.log(failures === 0 ? '\n ✅ PROVIDER CODEC LAWS PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
