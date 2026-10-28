import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pdfFixture, textPage } from './fixtures.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'native-pdf-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
const { modelSupportsPDF } = await import('../../src/utils/model/capabilities.ts')
const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.ts')
const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { buildGeminiRequest } = await import('../../src/services/providers/gemini/geminiCodec.ts')
const { streamGeminiContent } = await import('../../src/services/providers/gemini/geminiClient.ts')
const data = pdfFixture([textPage('Native PDF fixture')]).toString('base64')
const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Read this paper.' }, doc] }] as never
const hits: any[] = []
let refusal = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json()
  hits.push({ url: request.url, body })
  if (refusal) return Response.json({ error: { message: 'fixture refuses this document', code: 'invalid_file' } }, { status: 400 })
  const events = request.url.includes('/responses') ? [
    { type: 'response.output_text.delta', item_id: 'message-1', delta: 'paper read' },
    { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [], usage: { input_tokens: 23, output_tokens: 3, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } },
  ] : [{ candidates: [{ content: { role: 'model', parts: [{ text: 'paper read', thoughtSignature: 'signature-kept' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 3, cachedContentTokenCount: 2, thoughtsTokenCount: 1 } }]
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
try {
  assert.equal(modelSupportsPDF('gpt-6-astra'), true)
  assert.equal(modelSupportsPDF('gemini-3.8-flash'), true)
  assert.equal(modelSupportsPDF('claude-sonnet-5-5'), true)
  for (const unsupported of ['glm-5.3', 'openrouter/openai/gpt-6-astra', 'compat/gpt-6-astra', 'google/claude-sonnet-5-5']) assert.equal(modelSupportsPDF(unsupported), false)
  const openai = buildOpenaiResponsesRequest({ model: 'gpt-6-astra', messages, pdfSupported: true, reasoningEffort: 'max', maxOutputTokens: 8192 } as never)
  const events = []
  for await (const e of streamOpenaiResponses({ baseUrl: server.url.href, headers: {}, request: openai })) events.push(e)
  assert.ok(events.some(e => e.type === 'finish'))
  assert.ok(events.some(e => e.type === 'usage'))
  const openaiBody = hits.at(-1).body
  assert.equal(openaiBody.model, 'gpt-6-astra')
  assert.equal(openaiBody.input[0].content[1].file_data, `data:application/pdf;base64,${data}`)
  assert.equal(openaiBody.input[0].content[1].type, 'input_file')
  assert.equal(openaiBody.reasoning.effort, 'max')
  assert.equal(openaiBody.max_output_tokens, 8192)
  assert.equal(openaiBody.store, false)
  const request = { model: 'gemini-3.8-flash', messages: mapMessagesToZai(undefined, messages, { pdfSupported: true } as never), extra: { reasoning_effort: 'high', max_tokens: 8192 } }
  const gemini = buildGeminiRequest(request, [])
  assert.deepEqual(gemini.contents[0]?.parts[1]?.inlineData, { mimeType: 'application/pdf', data })
  const gEvents = []
  for await (const e of streamGeminiContent({ apiKey: 'fixture-key', url: `${server.url}models/gemini-3.8-flash:streamGenerateContent?alt=sse`, request, messages: [], onTurn: () => {} })) gEvents.push(e)
  assert.ok(gEvents.some(e => e.type === 'finish'))
  assert.equal(hits.at(-1).body.contents[0].parts[1].inlineData.data, data)
  assert.equal(hits.at(-1).body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH')
  assert.equal(hits.at(-1).body.generationConfig.maxOutputTokens, 8192)
  assert.match(JSON.stringify(buildOpenaiResponsesRequest({ model: 'gpt-6-astra', messages, pdfSupported: false } as never)), /\[document\]/)
  assert.match(JSON.stringify(mapMessagesToZai(undefined, messages)), /\[document\]/)
  const round = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-pdf', name: 'Read', input: { file_path: 'paper.pdf' } }], turnRecord: { provider: 'openai', items: [{ type: 'reasoning', id: 'thinking-1', summary: [], encrypted_content: 'signed-thinking-kept' }, { type: 'function_call', call_id: 'call-pdf', name: 'Read', arguments: '{"file_path":"paper.pdf"}' }] } },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-pdf', content: [{ type: 'text', text: 'PDF returned' }, doc] }] },
  ]
  const replay = buildOpenaiResponsesRequest({ model: 'gpt-6-astra', messages: round, pdfSupported: true } as never)
  assert.equal((replay.input[0] as any).encrypted_content, 'signed-thinking-kept')
  assert.equal((replay.input[2] as any).call_id, 'call-pdf')
  assert.equal((replay.input[2] as any).output[1].file_data, `data:application/pdf;base64,${data}`)
  const gRound = buildGeminiRequest({ model: request.model, messages: mapMessagesToZai(undefined, round as never, { pdfSupported: true }) }, [])
  assert.equal(gRound.contents[1]?.parts[0]?.functionResponse?.name, 'Read')
  assert.equal(gRound.contents[1]?.parts[1]?.inlineData?.data, data)
  const cancelled = new AbortController()
  cancelled.abort()
  const before = hits.length
  for await (const _ of streamOpenaiResponses({ baseUrl: server.url.href, headers: {}, request: openai, signal: cancelled.signal })) {}
  assert.equal(hits.length, before)
  refusal = true
  const fault = []
  for await (const e of streamOpenaiResponses({ baseUrl: server.url.href, headers: {}, request: openai })) fault.push(e)
  assert.ok(fault.some(e => e.type === 'stream-fault'))
  refusal = false
  const recovered = []
  for await (const e of streamOpenaiResponses({ baseUrl: server.url.href, headers: {}, request: openai })) recovered.push(e)
  assert.ok(recovered.some(e => e.type === 'finish'))
  console.log('PASS native PDF on OpenAI Responses and Gemini generateContent: request bytes, capability negatives, effort, output limit, usage, completion and refusal recovery')
} finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
