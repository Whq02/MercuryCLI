#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-reasoning-continuations-proof-'))
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

const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { ollamaMessagesOf } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
type MessageParam = import('../../src/types/wire.ts').MessageParam
type ZaiMessage = import('../../src/services/providers/zai/zaiClient.ts').ZaiMessage

const history = [
  { role: 'user', content: 'first question' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'old thought', signature: '' },
      { type: 'text', text: 'first answer', citations: null },
    ],
  },
  { role: 'user', content: 'read the file and fix it' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'I should read it first', signature: '' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'const a = 1' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'now the edit', signature: '' },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/tmp/a.ts', old_string: '1', new_string: '2' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
] as unknown as readonly MessageParam[]

const assistants = (rows: readonly unknown[]): ZaiMessage[] => (rows as ZaiMessage[]).filter(row => row.role === 'assistant')

section('1 · the codec: reasoning kept on the assistant rows after the last plain user message (the active tool loop), dropped on the turns before it')
{
  const rows = mapMessagesToZai('sys', history, { keepReasoningAfterLastUser: true })
  const a = assistants(rows)
  check('three assistant rows ride the wire', a.length === 3, String(a.length))
  check('the first turn (before the last user question) carries NO reasoning_content', a[0] !== undefined && !('reasoning_content' in a[0]), JSON.stringify(a[0]))
  check('the first tool step of the active turn keeps its thinking', a[1]?.reasoning_content === 'I should read it first', JSON.stringify(a[1]))
  check('the second tool step of the active turn keeps its thinking', a[2]?.reasoning_content === 'now the edit', JSON.stringify(a[2]))
  check('tool_calls ride beside the kept reasoning with content null (the documented shape beside calls)', a[1]?.tool_calls?.length === 1 && a[1].content === null && a[2]?.tool_calls?.length === 1, JSON.stringify(a[1]))
  const off = mapMessagesToZai('sys', history)
  check('without the option nothing changes: no reasoning_content anywhere (today\'s default for every other lane)', assistants(off).every(row => !('reasoning_content' in row)))
  const whole = mapMessagesToZai('sys', history, { keepReasoningHistory: true })
  check('keepReasoningHistory (Kimi\'s law) still keeps every turn\'s reasoning', assistants(whole).every(row => typeof row.reasoning_content === 'string'))
}

section('2 · a tool-result row is not a user query: a user row carrying text beside a result starts a new query')
{
  const annotated = [
    ...history,
    { role: 'user', content: [{ type: 'text', text: 'also rename it' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'renaming', signature: '' }, { type: 'tool_use', id: 't3', name: 'Edit', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] },
  ] as unknown as readonly MessageParam[]
  const a = assistants(mapMessagesToZai('sys', annotated, { keepReasoningAfterLastUser: true }))
  check('the earlier loop\'s steps drop their reasoning once a new user text arrived', a.length === 4 && !('reasoning_content' in a[1]!) && !('reasoning_content' in a[2]!), JSON.stringify(a.map(row => row.reasoning_content ?? null)))
  check('the newest step keeps its reasoning', a[3]?.reasoning_content === 'renaming', JSON.stringify(a[3]))
  const stringUser = [...history.slice(0, 5), { role: 'user', content: 'string prompt' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'later', signature: '' }, { type: 'text', text: 'done', citations: null }] }] as unknown as readonly MessageParam[]
  const b = assistants(mapMessagesToZai('sys', stringUser, { keepReasoningAfterLastUser: true }))
  check('a string user prompt is a query too', !('reasoning_content' in b[1]!) && b[2]?.reasoning_content === 'later', JSON.stringify(b.map(row => row.reasoning_content ?? null)))
}

section('3 · the /api/chat body: an assistant row with reasoning_content carries it as `thinking` (the field Ollama renders back into the template)')
{
  const rows = mapMessagesToZai('sys', history, { keepReasoningAfterLastUser: true })
  const ollama = ollamaMessagesOf(rows as never)
  const a = ollama.filter(row => row.role === 'assistant') as Array<{ thinking?: string; content: string; tool_calls?: unknown[] }>
  check('the kept reasoning rides as thinking on the active turn\'s rows', a[1]?.thinking === 'I should read it first' && a[2]?.thinking === 'now the edit', JSON.stringify(a))
  check('the earlier turn carries no thinking key', a[0] !== undefined && !('thinking' in a[0]), JSON.stringify(a[0]))
  check('content is a string beside the calls (Ollama\'s shape)', a[1]?.content === '' && Array.isArray(a[1]?.tool_calls), JSON.stringify(a[1]))
}

section('4 · the local lane profile asks for it')
{
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
  type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.ts').LocalModelRecord
  const thinker: LocalModelRecord = { id: 'qwen3.5:9b', server: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', toolsDeclared: true, thinkingDeclared: true, family: 'qwen3', parameterSize: '9B' }
  const llamacpp: LocalModelRecord = { id: 'glm-4.7-flash', server: 'llamacpp', baseUrl: 'http://127.0.0.1:9/v1', toolsDeclared: true, family: 'glm4', parameterSize: '30B' }
  const profile = localLaneProfileFor(thinker) as { keepsReasoningOnContinuations?: (model: string) => boolean; keepsReasoningHistory?: (model: string) => boolean }
  check('an Ollama thinking model keeps reasoning on continuations', profile.keepsReasoningOnContinuations?.('qwen3.5:9b') === true)
  check('a llama.cpp model (thinking undeclared, the template decides) keeps it too', (localLaneProfileFor(llamacpp) as { keepsReasoningOnContinuations?: (model: string) => boolean }).keepsReasoningOnContinuations?.('glm-4.7-flash') === true)
  check('the whole-history law (Kimi\'s) stays off on local', profile.keepsReasoningHistory === undefined || profile.keepsReasoningHistory('qwen3.5:9b') === false)
}

section('5 · an assistant turn with no text, no kept reasoning and no call never replays as content "" (Devstral\'s template rejects it): it reads the thinking-only row')
{
  const { ASSISTANT_THINKING_ONLY_ROW } = await import('../../src/services/providers/zai/zaiCodec.ts')
  const silent = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thought', signature: '' }] },
    { role: 'user', content: 'say it' },
  ] as unknown as readonly MessageParam[]
  const dropped = assistants(mapMessagesToZai('sys', silent))
  check('reasoning off the wire: the row carries the thinking-only words, never ""', dropped[0]?.content === ASSISTANT_THINKING_ONLY_ROW && dropped[0].content !== '' && !('reasoning_content' in dropped[0]), JSON.stringify(dropped[0]))
  const kept = assistants(mapMessagesToZai('sys', silent, { keepReasoningHistory: true }))
  check('reasoning kept on the wire: content stays "" beside reasoning_content (the pinned Kimi shape)', kept[0]?.content === '' && kept[0].reasoning_content === 'only thought', JSON.stringify(kept[0]))
  const call = assistants(mapMessagesToZai('sys', [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }] as unknown as readonly MessageParam[]))
  check('beside a call content stays null (the documented shape)', call[0]?.content === null && call[0].tool_calls?.length === 1, JSON.stringify(call[0]))
  check('the words name what happened', ASSISTANT_THINKING_ONLY_ROW === '(thinking)')
}

console.log(failures === 0 ? '\nprove-local-reasoning-continuations: ALL GREEN' : `\nprove-local-reasoning-continuations: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
