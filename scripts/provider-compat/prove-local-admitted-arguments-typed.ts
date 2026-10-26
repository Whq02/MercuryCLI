#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-admitted-arguments-typed-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'ZAI_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_HOME']) delete process.env[key]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { repairArgumentsBySchema, typeTextBySchema, schemaPropertyType } = await import('../../src/services/providers/local/schemaTyping.ts')

section('1 · the shared typing: a string value is typed by the schema property it is declared under; anything else is left as it came')
{
  const schema = {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object' } },
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      pin: { type: 'boolean' },
      op: { type: 'string', enum: ['supersede', 'amend'] },
      query: { type: 'string' },
      maybe: { anyOf: [{ type: 'null' }, { type: 'array' }] },
      either: { type: ['string', 'number'] },
    },
  }
  const items = [{ content: 'the deploy target is the blue rack in room 4', topic: 'deployment' }]
  const typed = repairArgumentsBySchema({ items: JSON.stringify(items), limit: '20', ratio: '0.5', pin: 'true', op: 'amend', query: '42', maybe: '[1]', either: '7' }, schema)
  check('an array declared and sent as a JSON string becomes the array', JSON.stringify(typed.items) === JSON.stringify(items), JSON.stringify(typed.items))
  check('an integer sent as "20" becomes 20', typed.limit === 20, String(typed.limit))
  check('a number sent as "0.5" becomes 0.5', typed.ratio === 0.5, String(typed.ratio))
  check('a boolean sent as "true" becomes true', typed.pin === true, String(typed.pin))
  check('an enum string is untouched', typed.op === 'amend', String(typed.op))
  check('a string property keeps its digits as a string', typed.query === '42', String(typed.query))
  check('an anyOf whose first non-null option is array types the string', JSON.stringify(typed.maybe) === '[1]', JSON.stringify(typed.maybe))
  check('a type union that admits string is left a string', typed.either === '7', String(typed.either))

  const already = { items, limit: 20, pin: false }
  check('typed values are untouched and the same object comes back', repairArgumentsBySchema(already, schema) === already)
  const stray = { items: 'the blue rack', limit: 'twenty', pin: 'yes', unknown: '[1]' }
  const left = repairArgumentsBySchema(stray, schema)
  check('a string the schema type cannot take stays the string (array · integer · boolean), so the schema refuses it as today', left.items === 'the blue rack' && left.limit === 'twenty' && left.pin === 'yes', JSON.stringify(left))
  check('a key the schema does not declare is left alone', left.unknown === '[1]')
  check('an object-shaped string under an array of objects is parsed and wrapped as the one item', JSON.stringify(repairArgumentsBySchema({ items: '{"content":"x"}' }, schema).items) === '[{"content":"x"}]')
  check('an array-shaped string under an object type stays text', typeTextBySchema('[1,2]', 'object') === '[1,2]')
  check('the extractor and the gate read one property-type owner', schemaPropertyType(schema, 'limit') === 'integer' && schemaPropertyType(schema, 'nothing') === undefined)
  const markupSource = readFileSync(new URL('../../src/services/providers/local/toolCallMarkup.ts', import.meta.url), 'utf8')
  check('the markup extractor imports the shared typing and keeps no copy of it', markupSource.includes("from './schemaTyping.js'") && !/case 'integer'/.test(markupSource) && !/anyOf/.test(markupSource))
}

section('2 · settlement through the local lane: a stub Ollama answers a structured call whose non-string values are strings (the admitted-tool shape); the gate types them and the call mints')
const script: { ollama?: Record<string, unknown>[]; compat?: unknown[] } = {}
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    await request.text()
    if (path === '/api/chat' && script.ollama !== undefined) {
      return new Response(script.ollama.map(row => JSON.stringify(row)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
    }
    if (path.endsWith('/chat/completions') && script.compat !== undefined) {
      return new Response(script.compat.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 404 })
  },
})
const root = `http://127.0.0.1:${fixture.port}`
process.env.MERCURY_DEEPSEEK_API_BASE = root
process.env.DEEPSEEK_API_KEY = 'sk-fixture-deepseek'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { RetainTool, RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.ts').LocalModelRecord
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type CompatLaneProfile = import('../../src/services/providers/openaicompat/compatChatCallModel.ts').CompatLaneProfile
const ollamaRecord: LocalModelRecord = { id: 'qwen3.5:9b', server: 'ollama', baseUrl: `${root}/v1`, toolsDeclared: true, thinkingDeclared: true, family: 'qwen3', parameterSize: '9B' }
const READ = FileReadTool.name
const RETAIN = RetainTool.name
const RECALL = RecallTool.name
const pool = [ToolSearchTool, FileReadTool, RetainTool, RecallTool]

type Settled = { toolUses: Array<{ name: string; input: unknown }>; texts: string[]; stop: string | null | undefined; notes: string[] }
async function drive(profile: CompatLaneProfile, model: string, conversation: { messages?: unknown[]; tools?: unknown[] } = {}): Promise<Settled> {
  const assistants: AssistantMessage[] = []
  for await (const item of compatChatCallModel(profile, {
    messages: (conversation.messages ?? [createUserMessage({ content: 'read /tmp/a.ts' })]) as never,
    systemPrompt: ['fixture system prompt'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: (conversation.tools ?? pool) as never,
    signal: new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model, isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' } as never,
  })) {
    if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
  }
  const out: Settled = { toolUses: [], texts: [], stop: undefined, notes: [] }
  for (const message of assistants) {
    if ((message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) continue
    for (const block of message.message.content as Array<{ type: string; name?: string; input?: unknown; text?: string }>) {
      if (block.type === 'tool_use') out.toolUses.push({ name: block.name!, input: block.input })
      else if (block.type === 'text') out.texts.push(block.text!)
    }
    const refusals = (message as { refusedToolCalls?: Array<{ reason: string }> }).refusedToolCalls
    if (refusals !== undefined) out.notes.push(...(message.message.content as Array<{ text?: string }>).map(b => b.text ?? ''), ...refusals.map(r => r.reason))
    out.stop = message.message.stop_reason
  }
  return out
}
const ollamaCall = (name: string, args: Record<string, unknown>): Record<string, unknown>[] => [
  { model: 'qwen3.5:9b', message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false },
  { model: 'qwen3.5:9b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 20 },
]
const admitted = (names: string[]): unknown[] => [
  createUserMessage({ content: 'remember: the deploy target for this project is the blue rack in room 4' }),
  createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: ToolSearchTool.name, input: { query: `select:${names.join(',')}` } }] as never }),
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_ts_1', content: [{ type: 'text', text: `Admitted: ${names.join(', ')}` }, ...names.map(name => ({ type: 'tool_reference', tool_name: name }))] }] as never }),
]
const local = (conversation?: { messages?: unknown[]; tools?: unknown[] }) => drive(localLaneProfileFor(ollamaRecord), `local/${ollamaRecord.id}`, conversation)
const ITEMS = [{ content: 'Deploy target for this project: the blue rack in room 4.', context: 'the user said so', topic: 'deploy-target' }]

{
  script.ollama = ollamaCall(RETAIN, { items: JSON.stringify(ITEMS) })
  const settled = await local({ messages: admitted([RETAIN, RECALL]) })
  check(`${RETAIN} admitted through ToolSearch, its items a JSON string: one ${RETAIN} tool_use mints with items an array`, settled.toolUses.length === 1 && settled.toolUses[0]!.name === RETAIN && JSON.stringify((settled.toolUses[0]!.input as { items: unknown }).items) === JSON.stringify(ITEMS) && settled.stop === 'tool_use', JSON.stringify(settled))
  check('no refusal note rides the turn', settled.notes.length === 0, JSON.stringify(settled.notes))
}
{
  script.ollama = ollamaCall(RECALL, { query: 'deploy target', limit: '20' })
  const settled = await local({ messages: admitted([RETAIN, RECALL]) })
  check(`${RECALL} admitted, its limit "20": the tool_use mints with limit 20`, settled.toolUses.length === 1 && settled.toolUses[0]!.name === RECALL && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ query: 'deploy target', limit: 20 }) && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.ollama = ollamaCall(RECALL, { query: 'deploy target', limit: 'twenty' })
  const settled = await local({ messages: [createUserMessage({ content: 'what do you remember about the deploy target?' })] })
  check(`${RECALL} unadmitted (called blind) with an argument no typing can take: the call mints its block carrying the refusal, the admission road named`, settled.toolUses.length === 1 && settled.notes.some(note => note.includes('deferred tool')) && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.ollama = ollamaCall(READ, { file_path: '/tmp/a.ts', offset: 12 })
  const settled = await local()
  check(`a listed ${READ} with typed arguments mints them untouched`, settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12 }), JSON.stringify(settled))
}
{
  script.ollama = ollamaCall(READ, { file_path: '/tmp/a.ts', offset: '12' })
  const settled = await local()
  check(`a listed ${READ} whose offset came as "12" mints offset 12 (the local lane types every tool's strings, listed or admitted)`, settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12 }), JSON.stringify(settled))
}
{
  script.ollama = ollamaCall(RECALL, { query: 'deploy target', limit: 'twenty' })
  const settled = await local({ messages: admitted([RETAIN, RECALL]) })
  check('a string no schema type can take ("twenty" for an integer) is refused with the current words, on the block the executor answers', settled.toolUses.length === 1 && settled.notes.some(note => note.includes('Parameter `limit` expects type number, got string')) && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.ollama = ollamaCall(RETAIN, { items: 'the blue rack in room 4' })
  const settled = await local({ messages: admitted([RETAIN, RECALL]) })
  check('a plain sentence where the array goes is refused with the type sentence, on the block the executor answers', settled.toolUses.length === 1 && settled.notes.some(note => note.includes('Parameter `items` expects type array, got string')) && settled.stop === 'tool_use', JSON.stringify(settled))
}

section('2b · the stored call is the model\'s own: a schema default is applied at execution, never written into the tool_use row (a replayed row must re-ingest byte-identical on a local server)')
{
  const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
  const EDIT = FileEditTool.name
  const sent = { file_path: '/tmp/add.js', old_string: 'return a + b', new_string: 'return Number(a) + Number(b)' }
  script.ollama = ollamaCall(EDIT, sent)
  const settled = await local({ tools: [FileEditTool], messages: [createUserMessage({ content: 'coerce the numbers in add.js' })] })
  check(`${EDIT} called without replace_all: the stored tool_use input is byte-identical to what the model sent (no default written in)`, settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify(sent), JSON.stringify(settled.toolUses[0]?.input))
  script.ollama = ollamaCall(EDIT, { ...sent, replace_all: true })
  const explicit = await local({ tools: [FileEditTool], messages: [createUserMessage({ content: 'coerce the numbers in add.js' })] })
  check(`${EDIT} called with replace_all: the stored input keeps it as sent`, explicit.toolUses.length === 1 && JSON.stringify(explicit.toolUses[0]!.input) === JSON.stringify({ ...sent, replace_all: true }), JSON.stringify(explicit.toolUses[0]?.input))
  check(`the executor still reads the default at execution (${EDIT}'s schema parses the stored input to replace_all false)`, (FileEditTool.inputSchema.safeParse(settled.toolUses[0]!.input) as { success: boolean; data?: { replace_all?: boolean } }).data?.replace_all === false)
}

section('3 · on a hosted lane too: the same stringified number through the DeepSeek lane is typed by the declared schema and the call mints')
{
  const compatCall = (id: string, args: Record<string, unknown>): unknown[] => [
    { id, model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: RECALL, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id, model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 20 } },
  ]
  script.compat = compatCall('c1', { query: 'deploy target', limit: '20' })
  const settled = await drive(deepseekLaneProfile, 'deepseek-chat', { messages: admitted([RETAIN, RECALL]) })
  check(`DeepSeek: ${RECALL} admitted, its limit "20" mints with limit 20 (every route types by the declared schema)`, settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ query: 'deploy target', limit: 20 }) && settled.notes.length === 0, JSON.stringify(settled))
  script.compat = compatCall('c2', { query: 'deploy target', limit: 20 })
  const typed = await drive(deepseekLaneProfile, 'deepseek-chat', { messages: admitted([RETAIN, RECALL]) })
  check('DeepSeek: the typed call mints as before', typed.toolUses.length === 1 && JSON.stringify(typed.toolUses[0]!.input) === JSON.stringify({ query: 'deploy target', limit: 20 }), JSON.stringify(typed))
}
fixture.stop(true)

console.log(failures === 0 ? '\nprove-local-admitted-arguments-typed: ALL GREEN' : `\nprove-local-admitted-arguments-typed: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
