#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-tool-call-markup-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { extractToolCallMarkup } = await import('../../src/services/providers/local/toolCallMarkup.ts')

const TOOLS = [
  { name: 'bash', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } } },
  { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'integer' } } } },
  { name: 'write', input_schema: { type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' }, overwrite: { type: 'boolean' }, tags: { type: 'array' } } } },
  { name: 'Edit', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } },
]
const args = (raw: string | undefined): unknown => (raw === undefined ? undefined : JSON.parse(raw))

section('1 · Qwen XML (ollama/ollama#14745): prose, then <tool_call><function=bash><parameter=command>…')
{
  const text = 'Thinking: I need to mock Valkey for tests. Let me check how the app initializes Valkey.\n<tool_call>\n<function=bash>\n<parameter=command>\ngrep "redact" -r src | head\n</parameter>\n<parameter=timeout>\n30\n</parameter>\n</function>\n</tool_call>'
  const out = extractToolCallMarkup(text, TOOLS)
  check('the shape is read as qwen-xml with one call', out?.shape === 'qwen-xml' && out.calls.length === 1, JSON.stringify(out))
  check('the call names bash with the command whole (the one newline each side of the value dropped) and the number typed by the schema', out?.calls[0]?.name === 'bash' && JSON.stringify(args(out?.calls[0]?.argumentsRaw)) === JSON.stringify({ command: 'grep "redact" -r src | head', timeout: 30 }), out?.calls[0]?.argumentsRaw)
  check('the prose stays as the text, the markup gone', out?.text === 'Thinking: I need to mock Valkey for tests. Let me check how the app initializes Valkey.', JSON.stringify(out?.text))
  const two = extractToolCallMarkup('<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/b.ts\n</parameter>\n<parameter=offset>\n12\n</parameter>\n</function>\n</tool_call>', TOOLS)
  check('two envelopes read as two calls, the text empty', two?.calls.length === 2 && two.text === '' && JSON.stringify(args(two.calls[1]?.argumentsRaw)) === JSON.stringify({ file_path: '/tmp/b.ts', offset: 12 }), JSON.stringify(two))
}

section('2 · JSON in <tool_call> (Qwen3 · Hermes): arguments as an object or a JSON string')
{
  const object = extractToolCallMarkup('<tool_call>\n{"name": "Read", "arguments": {"file_path": "/tmp/a.ts", "offset": 12}}\n</tool_call>', TOOLS)
  const string = extractToolCallMarkup('<tool_call>{"name":"Read","arguments":"{\\"file_path\\":\\"/tmp/a.ts\\"}"}</tool_call>', TOOLS)
  check('the object form reads json-in-xml with the arguments whole', object?.shape === 'json-in-xml' && JSON.stringify(args(object.calls[0]?.argumentsRaw)) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12 }), JSON.stringify(object))
  check('the string form parses the inner JSON', string?.shape === 'json-in-xml' && JSON.stringify(args(string.calls[0]?.argumentsRaw)) === JSON.stringify({ file_path: '/tmp/a.ts' }), JSON.stringify(string))
}

section('3 · GLM XML (GLM-4.5-Air · GLM-4.7-Flash): <tool_call>Name<arg_key>…</arg_key><arg_value>…</arg_value>')
{
  const out = extractToolCallMarkup('Let me read it.\n<tool_call>Read\n<arg_key>file_path</arg_key>\n<arg_value>/tmp/a.ts</arg_value>\n<arg_key>offset</arg_key>\n<arg_value>12</arg_value>\n</tool_call>', TOOLS)
  check('the shape is glm-xml, the keys and schema-typed values read', out?.shape === 'glm-xml' && JSON.stringify(args(out.calls[0]?.argumentsRaw)) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12 }), JSON.stringify(out))
  check('the prose before it stays', out?.text === 'Let me read it.', JSON.stringify(out?.text))
}

section('4 · Gemma 4 (ollama/ollama#15315): <|tool_call>call:name{key:<|"|>text<|"|>,n:42}<tool_call|>, and the bare call:… when the server drops the special tokens')
{
  const body = '# Project Style Guide\n\nThis document captures the *de facto* standards, with "quotes", {braces} and a comma, here.'
  const wrapped = extractToolCallMarkup(`<|tool_call>call:write{content:<|"|>${body}<|"|>,path:<|"|>AGENTS.md<|"|>,overwrite:true,tags:[<|"|>a<|"|>,2]}<tool_call|>`, TOOLS)
  check('the wrapped form reads gemma with every value typed by the grammar (string · boolean · list)', wrapped?.shape === 'gemma' && JSON.stringify(args(wrapped.calls[0]?.argumentsRaw)) === JSON.stringify({ content: body, path: 'AGENTS.md', overwrite: true, tags: ['a', 2] }), JSON.stringify(wrapped))
  const bare = extractToolCallMarkup(`call:write{content:<|"|>${body}<|"|>,path:<|"|>AGENTS.md<|"|>}`, TOOLS)
  check('the bare form (the whole text one call) reads the same way', bare?.shape === 'gemma' && JSON.stringify(args(bare.calls[0]?.argumentsRaw)) === JSON.stringify({ content: body, path: 'AGENTS.md' }) && bare.text === '', JSON.stringify(bare))
  const nested = extractToolCallMarkup('<|tool_call>call:Read{file_path:<|"|>/tmp/a.ts<|"|>,offset:12,limit:3}<tool_call|>', TOOLS)
  check('numbers stay numbers', JSON.stringify(args(nested?.calls[0]?.argumentsRaw)) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12, limit: 3 }), JSON.stringify(nested))
  check('prose that merely says "call:" is not a call', extractToolCallMarkup('Please call: the owner before you write{anything}.', TOOLS) === undefined)
}

section('5 · Mistral / Devstral: [TOOL_CALLS]name[ARGS]{…}')
{
  const out = extractToolCallMarkup('[TOOL_CALLS]Read[ARGS]{"file_path": "/tmp/a.ts", "offset": 12}', TOOLS)
  check('the shape is mistral with the JSON arguments', out?.shape === 'mistral' && JSON.stringify(args(out.calls[0]?.argumentsRaw)) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12 }) && out.text === '', JSON.stringify(out))
  const two = extractToolCallMarkup('I will edit both.[TOOL_CALLS]Edit[ARGS]{"file_path":"a","old_string":"x","new_string":"{y}"}[TOOL_CALLS]Read[ARGS]{"file_path":"b"}', TOOLS)
  check('two calls, braces inside strings respected, the prose kept', two?.calls.length === 2 && two.text === 'I will edit both.' && JSON.stringify(args(two.calls[0]?.argumentsRaw)) === JSON.stringify({ file_path: 'a', old_string: 'x', new_string: '{y}' }), JSON.stringify(two))
}

section('6 · a partial or malformed shape, or a name the request did not carry, extracts nothing')
{
  check('an unclosed Qwen envelope stays text', extractToolCallMarkup('<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a.ts', TOOLS) === undefined)
  check('a function the request did not declare stays text', extractToolCallMarkup('<tool_call>\n<function=Nope>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>', TOOLS) === undefined)
  check('one whole envelope beside one broken envelope: nothing is read (never a half turn)', extractToolCallMarkup('<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=Read>', TOOLS) === undefined)
  check('a Gemma call missing its closing brace stays text', extractToolCallMarkup('<|tool_call>call:Read{file_path:<|"|>/tmp/a.ts<|"|>', TOOLS) === undefined)
  check('a Mistral call with unbalanced JSON stays text', extractToolCallMarkup('[TOOL_CALLS]Read[ARGS]{"file_path": "/tmp/a.ts"', TOOLS) === undefined)
  check('plain prose is never a call', extractToolCallMarkup('Done. The tests pass.', TOOLS) === undefined)
  check('with no tools on the request nothing is read', extractToolCallMarkup('<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>', []) === undefined)
}

section('6b · a call is read only when the LAST shape ends the text; a shape inside a code fence or backticks is a quoted example, never a call')
{
  const QWEN = `<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>`
  const JSONX = '<tool_call>{"name":"Read","arguments":{"file_path":"/tmp/a.ts"}}</tool_call>'
  const GLM = '<tool_call>Read\n<arg_key>file_path</arg_key>\n<arg_value>/tmp/a.ts</arg_value>\n</tool_call>'
  const GEMMA = '<|tool_call>call:Read{file_path:<|"|>/tmp/a.ts<|"|>}<tool_call|>'
  const MISTRAL = '[TOOL_CALLS]Read[ARGS]{"file_path": "/tmp/a.ts"}'
  const FENCE = '```'
  const TICK = '`'
  for (const [shape, markup] of [['qwen-xml', QWEN], ['json-in-xml', JSONX], ['glm-xml', GLM], ['gemma', GEMMA], ['mistral', MISTRAL]] as const) {
    check(`${shape}: the shape ending the text mints (trailing whitespace allowed)`, extractToolCallMarkup(`Reading it.\n${markup}\n\n`, TOOLS)?.shape === shape)
    check(`${shape}: the shape followed by prose is not a call (the text does not end on it)`, extractToolCallMarkup(`${markup}\nThat is what I would run if you agree.`, TOOLS) === undefined)
    check(`${shape}: the shape inside a code fence is a quoted example, never a call`, extractToolCallMarkup(`Here is how I would call it:\n${FENCE}\n${markup}\n${FENCE}\n`, TOOLS) === undefined)
    check(`${shape}: the shape inside backticks is a quoted example, never a call`, extractToolCallMarkup(`The format is ${TICK}${markup}${TICK}`, TOOLS) === undefined)
  }
  const bare = 'call:Read{file_path:<|"|>/tmp/a.ts<|"|>}'
  check('gemma bare: followed by prose it is not a call', extractToolCallMarkup(`${bare} and then I would stop.`, TOOLS) === undefined)
  const fencedThenReal = `Example:\n${FENCE}\n${MISTRAL}\n${FENCE}\nNow for real:\n${MISTRAL}`
  check('a fenced example AND a real call ending the text: only the real one is read, the fenced one stays in the text', (() => {
    const out = extractToolCallMarkup(fencedThenReal, TOOLS)
    return out?.calls.length === 1 && out.text.includes(FENCE) && out.text.includes('[TOOL_CALLS]') && out.text.endsWith('Now for real:')
  })(), JSON.stringify(extractToolCallMarkup(fencedThenReal, TOOLS)))
  const ticked = extractToolCallMarkup(`<tool_call>\n<function=bash>\n<parameter=command>\necho ${TICK}date${TICK} > out.txt\n</parameter>\n</function>\n</tool_call>`, TOOLS)
  check('backticks inside an argument value are the value, byte for byte', JSON.stringify(args(ticked?.calls[0]?.argumentsRaw)) === JSON.stringify({ command: `echo ${TICK}date${TICK} > out.txt` }), ticked?.calls[0]?.argumentsRaw)
  const content = `# Notes\n\n${FENCE}ts\nconst a = 1\n${FENCE}\n`
  const fencedValue = extractToolCallMarkup(`<tool_call>\n<function=write>\n<parameter=path>\nNOTES.md\n</parameter>\n<parameter=content>\n${content}\n</parameter>\n</function>\n</tool_call>`, TOOLS)
  check('a code fence inside an argument value is the value, byte for byte', JSON.stringify(args(fencedValue?.calls[0]?.argumentsRaw)) === JSON.stringify({ path: 'NOTES.md', content }), fencedValue?.calls[0]?.argumentsRaw)
}

section('7 · settlement through the local lane on both transports: the markup becomes a gated tool_use block, the prose a text block, the stop reason tool_use')
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
    if (path === '/v1/chat/completions' && script.compat !== undefined) {
      return new Response(script.compat.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 404 })
  },
})
const root = `http://127.0.0.1:${fixture.port}`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.ts').LocalModelRecord
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
const ollamaRecord: LocalModelRecord = { id: 'qwen3.5:9b', server: 'ollama', baseUrl: `${root}/v1`, toolsDeclared: true, thinkingDeclared: true, family: 'qwen3', parameterSize: '9B' }
const llamaRecord: LocalModelRecord = { id: 'glm-4.7-flash', server: 'llamacpp', baseUrl: `${root}/v1`, toolsDeclared: true, thinkingDeclared: false, family: 'glm4', parameterSize: '30B' }
const READ = FileReadTool.name

type Settled = { toolUses: Array<{ name: string; input: unknown }>; texts: string[]; thinking: string[]; stop: string | null | undefined; notes: string[] }
async function drive(record: LocalModelRecord, conversation: { messages?: unknown[]; tools?: unknown[] } = {}): Promise<Settled> {
  const assistants: AssistantMessage[] = []
  for await (const item of compatChatCallModel(localLaneProfileFor(record), {
    messages: (conversation.messages ?? [createUserMessage({ content: 'read /tmp/a.ts' })]) as never,
    systemPrompt: ['fixture system prompt'] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: (conversation.tools ?? [FileReadTool]) as never,
    signal: new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: `local/${record.id}`, isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' } as never,
  })) {
    if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
  }
  const out: Settled = { toolUses: [], texts: [], thinking: [], stop: undefined, notes: [] }
  for (const message of assistants) {
    if ((message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) continue
    for (const block of message.message.content as Array<{ type: string; name?: string; input?: unknown; text?: string; thinking?: string }>) {
      if (block.type === 'tool_use') out.toolUses.push({ name: block.name!, input: block.input })
      else if (block.type === 'text') out.texts.push(block.text!)
      else if (block.type === 'thinking') out.thinking.push(block.thinking!)
    }
    const refusals = (message as { refusedToolCalls?: Array<{ reason: string }> }).refusedToolCalls
    if (refusals !== undefined) out.notes.push(...(message.message.content as Array<{ text?: string }>).map(b => b.text ?? ''), ...refusals.map(r => r.reason))
    out.stop = message.message.stop_reason
  }
  return out
}
const doneRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'qwen3.5:9b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 20, ...extra })

{
  script.ollama = [
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: '', thinking: 'The user wants the file. ' }, done: false },
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: 'Reading it now.\n<tool_call>\n<function=' }, done: false },
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: `${READ}>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n<parameter=offset>\n12\n</parameter>\n</function>\n</tool_call>` }, done: false },
    doneRow(),
  ]
  const settled = await drive(ollamaRecord)
  check('Ollama /api/chat, Qwen XML in content with no tool_calls and done_reason stop: one Read tool_use block mints through the gate with typed input', settled.toolUses.length === 1 && settled.toolUses[0]!.name === READ && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 12 }), JSON.stringify(settled))
  check('the text block carries the prose without the markup', settled.texts.length === 1 && settled.texts[0] === 'Reading it now.', JSON.stringify(settled.texts))
  check('the stop reason reads tool_use (the loop continues)', settled.stop === 'tool_use', String(settled.stop))
  check('the thinking block stands as streamed', settled.thinking.length === 1 && settled.thinking[0] === 'The user wants the file. ', JSON.stringify(settled.thinking))
}
{
  script.ollama = [
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: '', thinking: `I will read the file.\n<tool_call>\n<function=${READ}>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>` }, done: false },
    doneRow(),
  ]
  const settled = await drive(ollamaRecord)
  check('the markup inside the thinking block alone (llama.cpp#20837, no content at all): the call mints and the thinking keeps its words without the markup', settled.toolUses.length === 1 && settled.thinking[0] === 'I will read the file.' && settled.texts.length === 0 && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.ollama = [
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: `<tool_call>\n<function=${READ}>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>` }, done: false },
    doneRow(),
  ]
  const settled = await drive(ollamaRecord)
  check('the whole content one call: no empty text block is minted beside the tool_use', settled.toolUses.length === 1 && settled.texts.length === 0 && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.ollama = [
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: `<tool_call>\n<function=${READ}>\n<parameter=file_path>\n/tmp/a.ts` }, done: false },
    doneRow(),
  ]
  const settled = await drive(ollamaRecord)
  check('a partial envelope stays text, no call, the turn ends', settled.toolUses.length === 0 && settled.texts.length === 1 && settled.texts[0]!.includes('<tool_call>') && settled.stop === 'end_turn', JSON.stringify(settled))
}
{
  script.ollama = [
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: `<tool_call>\n<function=${READ}>\n<parameter=file_path>\n/tmp/b.ts\n</parameter>\n</function>\n</tool_call>`, tool_calls: [{ function: { name: READ, arguments: { file_path: '/tmp/a.ts' } } }] }, done: false },
    doneRow({ done_reason: 'stop' }),
  ]
  const settled = await drive(ollamaRecord)
  check('a structured tool_call present: the structured road settles alone, the text is left as the server sent it (the fallback never runs beside a parsed call)', settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts' }) && settled.texts.length === 1 && settled.texts[0]!.includes('/tmp/b.ts'), JSON.stringify(settled))
}
{
  script.ollama = [
    { model: 'qwen3.5:9b', message: { role: 'assistant', content: `<tool_call>\n<function=${READ}>\n<parameter=offset>\n12\n</parameter>\n</function>\n</tool_call>` }, done: false },
    doneRow(),
  ]
  const settled = await drive(ollamaRecord)
  check('a read call missing its required file_path goes through the gate and comes back as a block carrying the schema refusal, for the executor to answer', settled.toolUses.length === 1 && settled.toolUses[0]!.name === READ && settled.notes.some(note => note.includes('file_path')) && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.compat = [
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me read it.\n<tool_call>' }, finish_reason: null }] },
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: { content: `${READ}\n<arg_key>file_path</arg_key>\n<arg_value>/tmp/a.ts</arg_value>\n<arg_key>limit</arg_key>\n<arg_value>40</arg_value>\n</tool_call>` }, finish_reason: null }] },
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } },
  ]
  const settled = await drive(llamaRecord)
  check('llama.cpp /v1/chat/completions, GLM XML in content with finish_reason stop: the Read block mints with the schema-typed limit, the prose stays', settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts', limit: 40 }) && settled.texts[0] === 'Let me read it.' && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.compat = [
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: { role: 'assistant', content: `<|tool_call>call:${READ}{file_path:<|"|>/tmp/a.ts<|"|>,offset:3}<tool_call|>` }, finish_reason: null }] },
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const settled = await drive(llamaRecord)
  check('the Gemma grammar through the compat road mints the same way', settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts', offset: 3 }) && settled.stop === 'tool_use', JSON.stringify(settled))
}
{
  script.compat = [
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: { role: 'assistant', content: `[TOOL_CALLS]${READ}[ARGS]{"file_path": "/tmp/a.ts"}` }, finish_reason: null }] },
    { id: 'c1', model: 'glm-4.7-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const settled = await drive(llamaRecord)
  check('the Mistral grammar through the compat road mints the same way', settled.toolUses.length === 1 && JSON.stringify(settled.toolUses[0]!.input) === JSON.stringify({ file_path: '/tmp/a.ts' }) && settled.stop === 'tool_use', JSON.stringify(settled))
}

section('7b · the extractor reads the gate\'s own view: a deferred tool ADMITTED this session (its definition rides the ToolSearch result row, not the tools term) mints from markup; the same tool unadmitted stays text')
{
  const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
  const { WebFetchTool } = await import('../../src/tools/WebFetchTool/WebFetchTool.ts')
  const { createAssistantMessage } = await import('../../src/utils/messages.ts')
  const FETCH = WebFetchTool.name
  const pool = [ToolSearchTool, FileReadTool, WebFetchTool]
  const markup = `<tool_call>\n<function=${FETCH}>\n<parameter=url>\nhttps://example.com/\n</parameter>\n<parameter=prompt>\nthe title\n</parameter>\n</function>\n</tool_call>`
  const opening = createUserMessage({ content: 'fetch https://example.com/ and tell me the title' })
  const search = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: ToolSearchTool.name, input: { query: `select:${FETCH}` } }] as never })
  const admission = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_ts_1', content: [{ type: 'text', text: `Admitted: ${FETCH}` }, { type: 'tool_reference', tool_name: FETCH }] }] as never })
  script.ollama = [{ model: 'qwen3.5:9b', message: { role: 'assistant', content: markup }, done: false }, doneRow()]
  const admitted = await drive(ollamaRecord, { tools: pool, messages: [opening, search, admission] })
  check(`${FETCH} is deferred on the local road yet admitted here: its markup mints a ${FETCH} tool_use with the typed input`, admitted.toolUses.length === 1 && admitted.toolUses[0]!.name === FETCH && JSON.stringify(admitted.toolUses[0]!.input) === JSON.stringify({ url: 'https://example.com/', prompt: 'the title' }) && admitted.stop === 'tool_use', JSON.stringify(admitted))
  script.ollama = [{ model: 'qwen3.5:9b', message: { role: 'assistant', content: markup }, done: false }, doneRow()]
  const unadmitted = await drive(ollamaRecord, { tools: pool, messages: [createUserMessage({ content: 'fetch https://example.com/ and tell me the title' })] })
  check(`the same markup with ${FETCH} unadmitted: no tool_use, the text stands, the turn ends`, unadmitted.toolUses.length === 0 && unadmitted.texts.length === 1 && unadmitted.texts[0]!.includes('<tool_call>') && unadmitted.stop === 'end_turn', JSON.stringify(unadmitted))
  script.ollama = [{ model: 'qwen3.5:9b', message: { role: 'assistant', content: `<tool_call>\n<function=${READ}>\n<parameter=file_path>\n/tmp/a.ts\n</parameter>\n</function>\n</tool_call>` }, done: false }, doneRow()]
  const listed = await drive(ollamaRecord, { tools: pool, messages: [createUserMessage({ content: 'read /tmp/a.ts' })] })
  check('a tool the tools term carries mints as before beside the deferred pool', listed.toolUses.length === 1 && listed.toolUses[0]!.name === READ && listed.stop === 'tool_use', JSON.stringify(listed))
}
fixture.stop(true)

console.log(failures === 0 ? '\nprove-local-tool-call-markup: ALL GREEN' : `\nprove-local-tool-call-markup: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
