#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dialect-chat-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.GEMINI_API_KEY = 'fixture-gemini-key'
process.env.ZAI_API_KEY = 'fixture-zai-key'
process.env.MERCURY_ZAI_API_BASE = 'https://zai.fixture.invalid/v4'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_MODEL
for (const name of ['MERCURY_GEMINI_API_BASE', 'MERCURY_GEMINI_OAUTH_TOKEN_BASE', 'MERCURY_BUSY_RETRY_SCALE']) delete process.env[name]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n  ' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)

const { mapMessagesToZai, buildZaiChatRequest } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { userMessageToMessageParam, assistantMessageToMessageParam } = await import('../../src/services/providers/anthropic/messageParams.ts')
const { healWalkableForWire } = await import('../../src/utils/messages.ts')
const { buildGeminiRequest } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { ollamaChatBody, ollamaMessagesOf } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const { DIALECT_CONVERSATION, TWO_MODEL_COMPACTION, VIRTUAL_ROW, canonicalJson } = await import('./dialectFixture.ts')
import type { Message } from '../../src/types/message.ts'

function bridgeRows(messages: Message[]): { role: 'user' | 'assistant'; content: unknown }[] {
  const healed = healWalkableForWire(messages as never)
  return healed.map(m => (m.type === 'user' ? { role: 'user' as const, content: userMessageToMessageParam(m, false, false).content } : { role: 'assistant' as const, content: assistantMessageToMessageParam(m, false, false).content }))
}

section('GEMINI — the native codec over the fixture conversation (contents, parts, calls)')
{
  const rows = bridgeRows(DIALECT_CONVERSATION)
  const compatRequest = buildZaiChatRequest({ model: 'gemini-3.5-flash', system: 'You are the dialect fixture.', messages: rows as never })
  const body = buildGeminiRequest(compatRequest as never, DIALECT_CONVERSATION)
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + canonicalJson(body))
  const wire = canonicalJson(body)
  check('systemInstruction carries the system text as one part', canonicalJson(body.systemInstruction) === '{"parts":[{"text":"You are the dialect fixture."}]}')
  check('the user image rides as inlineData with the base64 payload', wire.includes('"inlineData"') && wire.includes('aWF0dG9rZW4='))
  check('the tool calls pair as functionCall parts with parsed args', wire.includes('"functionCall"') && wire.includes('{"name":"Read"') && wire.includes('{"name":"Bash"'))
  check('the results pair as functionResponse with output text', wire.includes('"functionResponse"') && wire.includes('the quick brown fox jumps over the lazy dog'))
  check('the sonnet thinking never rides (cross-provider reasoning stays off)', !wire.includes('sig-fixture-sonnet-1') && !wire.includes('considering the count'))
  check('roles read user/model with no empty parts array', !wire.includes('"parts":[]'))
  check('the response order follows the assistant\'s own call order', body.contents.flatMap(row => row.parts).filter(part => part.functionResponse).map(part => part.functionResponse?.name).join(',') === 'Read,Bash')
  const GOLDEN_BODY = `{"contents":[{"parts":[{"text":"Count the words in my notes file."}],"role":"user"},{"parts":[{"text":"I will read the file first."}],"role":"model"},{"parts":[{"text":"here is the screenshot of the file too"},{"inlineData":{"data":"aWF0dG9rZW4=","mimeType":"image/png"}}],"role":"user"},{"parts":[{"text":"Reading and counting now."},{"functionCall":{"args":{"file_path":"/proj/notes.txt"},"name":"Read"},"thoughtSignature":"skip_thought_signature_validator"},{"functionCall":{"args":{"command":"wc -w /proj/notes.txt"},"name":"Bash"}}],"role":"model"},{"parts":[{"functionResponse":{"name":"Read","response":{"output":"the quick brown fox jumps over the lazy dog"}}},{"functionResponse":{"name":"Bash","response":{"output":"9 words"}}}],"role":"user"},{"parts":[{"text":"The file holds nine words."}],"role":"model"},{"parts":[{"text":"Summarise what you found in one sentence."}],"role":"user"}],"systemInstruction":{"parts":[{"text":"You are the dialect fixture."}]}}`
  check('the complete Gemini body is byte-identical to the base golden', wire === GOLDEN_BODY, firstDivergence(wire, GOLDEN_BODY))
}

section('GEMINI — the two-model shape: the other model\'s thinking stays off, its text stays')
{
  const rows = bridgeRows(TWO_MODEL_COMPACTION)
  const compatRequest = buildZaiChatRequest({ model: 'gemini-3.5-flash', system: 'You are the dialect fixture.', messages: rows as never })
  const body = buildGeminiRequest(compatRequest as never, TWO_MODEL_COMPACTION)
  const wire = canonicalJson(body)
  check('the opus thinking blocks are absent', !wire.includes('sig-fixture-opus') && !wire.includes('opus weighed'))
  check('the opus text survives as a model turn', wire.includes('Here is the tool sketch.'))
}

section('OPENAI-COMPATIBLE CHAT — mapMessagesToZai over the fixture conversation')
{
  const rows = bridgeRows(DIALECT_CONVERSATION)
  const body = mapMessagesToZai('You are the dialect fixture.', rows as never)
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + canonicalJson(body))
  const wire = canonicalJson(body)
  check('the system row leads', (body[0] as { role?: string })?.role === 'system' && (body[0] as { content?: string })?.content === 'You are the dialect fixture.')
  check('a plain user row rides as one string content', canonicalJson(body[1]) === '{"content":"Count the words in my notes file.","role":"user"}', canonicalJson(body[1]))
  check('the tool round: assistant tool_calls then role:tool rows, ids paired', wire.includes('"tool_calls"') && wire.includes('"tool_call_id":"toolu_A"') && wire.includes('"tool_call_id":"toolu_B"'))
  check('the image rides as an image_url data part', wire.includes('"image_url"') && wire.includes('data:image/png;base64,aWF0dG9rZW4='))
  check('the thinking blocks never ride (keepReasoningHistory defaults off)', !wire.includes('sig-fixture') && !wire.includes('considering the count'))
  const GOLDEN = `[{"content":"You are the dialect fixture.","role":"system"},{"content":"Count the words in my notes file.","role":"user"},{"content":"I will read the file first.","role":"assistant"},{"content":[{"text":"here is the screenshot of the file too","type":"text"},{"image_url":{"url":"data:image/png;base64,aWF0dG9rZW4="},"type":"image_url"}],"role":"user"},{"content":"Reading and counting now.","role":"assistant","tool_calls":[{"function":{"arguments":"{\\"file_path\\":\\"/proj/notes.txt\\"}","name":"Read"},"id":"toolu_A","type":"function"},{"function":{"arguments":"{\\"command\\":\\"wc -w /proj/notes.txt\\"}","name":"Bash"},"id":"toolu_B","type":"function"}]},{"content":"the quick brown fox jumps over the lazy dog","role":"tool","tool_call_id":"toolu_A"},{"content":"9 words","role":"tool","tool_call_id":"toolu_B"},{"content":"The file holds nine words.","role":"assistant"},{"content":"Summarise what you found in one sentence.","role":"user"}]`
  check('the chat-completions rows are byte-identical to the base golden', wire === GOLDEN, `first divergence near ${firstDivergence(wire, GOLDEN)}`)
}

section('OPENAI-COMPATIBLE CHAT — a virtual row (the family-lane wire truth, recorded)')
{
  const withVirtual = [...DIALECT_CONVERSATION.slice(0, 2), VIRTUAL_ROW as never, ...DIALECT_CONVERSATION.slice(2)]
  const rows = bridgeRows(withVirtual)
  const body = mapMessagesToZai(undefined, rows as never)
  const wire = canonicalJson(body)
  check('RECORDED TRUTH (base): the virtual row RIDES the chat wire as an assistant row — the plan must keep these bytes until a bug is named', wire.includes('a display-only row'), wire.slice(0, 260))
}

section('LOCAL (Ollama) — the /api/chat body over the fixture conversation')
{
  const rows = bridgeRows(DIALECT_CONVERSATION)
  const compatRequest = buildZaiChatRequest({ model: 'qwen3.5:9b', system: 'You are the dialect fixture.', messages: rows as never })
  const body = ollamaChatBody(compatRequest as never, { numCtx: 8192 })
  if (process.env.DIALECT_PRINT === '1') console.log('  PRINTED: ' + canonicalJson(body))
  const wire = canonicalJson(body)
  check('the model and stream flags ride', body.model === 'qwen3.5:9b' && body.stream === true)
  check('truncate is false (the silent-truncation guard)', body.truncate === false)
  check('the image rides as a bare base64 images entry', wire.includes('"images":["aWF0dG9rZW4="]'))
  check('tool calls ride as parsed argument objects with tool_name on the tool rows', wire.includes('"tool_name":"Read"') && wire.includes('"tool_name":"Bash"') && wire.includes('"tool_calls"'))
  check('num_ctx rides under options', canonicalJson(body.options) === '{"num_ctx":8192}')
  check('the thinking blocks never ride', !wire.includes('sig-fixture') && !wire.includes('considering the count'))
  const messages = ollamaMessagesOf(compatRequest.messages as never)
  const GOLDEN_MESSAGES = `[{"content":"You are the dialect fixture.","role":"system"},{"content":"Count the words in my notes file.","role":"user"},{"content":"I will read the file first.","role":"assistant"},{"content":"here is the screenshot of the file too","images":["aWF0dG9rZW4="],"role":"user"},{"content":"Reading and counting now.","role":"assistant","tool_calls":[{"function":{"arguments":{"file_path":"/proj/notes.txt"},"name":"Read"},"id":"toolu_A"},{"function":{"arguments":{"command":"wc -w /proj/notes.txt"},"name":"Bash"},"id":"toolu_B"}]},{"content":"the quick brown fox jumps over the lazy dog","role":"tool","tool_call_id":"toolu_A","tool_name":"Read"},{"content":"9 words","role":"tool","tool_call_id":"toolu_B","tool_name":"Bash"},{"content":"The file holds nine words.","role":"assistant"},{"content":"Summarise what you found in one sentence.","role":"user"}]`
  check('the Ollama rows are byte-identical to the base golden', canonicalJson(messages) === GOLDEN_MESSAGES, `first divergence near ${firstDivergence(canonicalJson(messages), GOLDEN_MESSAGES)}`)
}

console.log(failures === 0 ? '\n✅ CHAT DIALECTS CONTRACT GREEN (gemini · openai-compatible · local)' : `\n❌ ${failures} CHAT DIALECT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

function firstDivergence(a: string, b: string): string {
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  return `${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`
}
