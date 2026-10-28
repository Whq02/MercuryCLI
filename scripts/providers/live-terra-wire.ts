import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { setAuthScope, clearAuthScope } from '../../src/utils/envUtils.js'
import { resolveOpenaiRequestAuth } from '../../src/services/providers/openai/openaiAccounts.js'
import { streamOpenaiResponses } from '../../src/services/providers/openai/openaiClient.js'
import { buildOpenaiResponsesRequest } from '../../src/services/providers/openai/responsesBridge.js'
import { getApiFetch, getProxyFetchOptions } from '../../src/utils/proxy.js'
import { SseDecoder } from '../../src/services/providers/sseDecoder.js'
import type { OpenaiInputItem, OpenaiResponsesRequest, OpenaiStreamEvent } from '../../src/services/providers/openai/openaiWire.js'

const at = process.argv.indexOf('--auth-home')
const authHome = at >= 0 ? process.argv[at + 1] : undefined
if (!process.argv.includes('--live') || !authHome || !process.env.MERCURY_CONFIG_DIR || resolve(authHome) === resolve(process.env.MERCURY_CONFIG_DIR)) {
  console.error('Usage: live-terra-wire --live --auth-home <credential home>, with MERCURY_CONFIG_DIR set to a separate scratch home')
  process.exit(2)
}
if (process.env.MERCURY_WIRE_DUMP) throw new Error('Wire dumps must be off for this probe')
setAuthScope(authHome)
const auth = await (async () => {
  try { return await resolveOpenaiRequestAuth({ readOnly: true }) }
  finally { clearAuthScope() }
})()
if (!auth) { console.error('No fresh OpenAI credential; no refresh or inference attempted.'); process.exit(1) }
assert.ok(['api.openai.com', 'chatgpt.com'].includes(new URL(auth.baseUrl).hostname))
const model = 'gpt-6.1-terra'
console.log(JSON.stringify({ provider: 'openai', accountKind: auth.account.kind, endpoint: `${auth.baseUrl}/responses`, selectedModel: model }))

function redImage(): string {
  const crc = (bytes: Buffer): number => {
    let n = 0xffffffff
    for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0) }
    return (n ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body))
    return Buffer.concat([size, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
  const raw = Buffer.alloc(64 * (1 + 64 * 3))
  for (let row = 0; row < 64; row++) for (let col = 0; col < 64; col++) raw[row * 193 + 1 + col * 3] = 255
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`
}
let calls = 0
let totalCost = 0
const actualFetch = getApiFetch()
const summaries: Record<string, unknown>[] = []
async function call(request: OpenaiResponsesRequest, purpose: string): Promise<Extract<OpenaiStreamEvent, { type: 'finish' }>> {
  const started = Date.now()
  let headersMs: number | undefined, firstByteMs: number | undefined, firstDeltaMs: number | undefined
  const eventCounts: Record<string, number> = {}, shapes: Record<string, number> = {}, itemShapes: Record<string, number> = {}
  const pings: number[] = [], chunkTimes: number[] = []
  const responseFacts: Record<string, unknown> = {}
  const decoder = new SseDecoder()
  const textDecoder = new TextDecoder()
  let lineBuffer = ''
  let bytes = 0
  const observe = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return
    const o = payload as Record<string, any>
    if (typeof o.type !== 'string') return
    eventCounts[o.type] = (eventCounts[o.type] ?? 0) + 1
    const shape = `${o.type}:${Object.keys(o).sort().join(',')}`
    shapes[shape] = (shapes[shape] ?? 0) + 1
    if (o.type.endsWith('.delta') && firstDeltaMs === undefined) firstDeltaMs = Date.now() - started
    if (o.item && typeof o.item === 'object') {
      const itemShape = `${o.item.type}:${Object.keys(o.item).sort().join(',')}`
      itemShapes[itemShape] = (itemShapes[itemShape] ?? 0) + 1
    }
    if (o.response) {
      if (typeof o.response.model === 'string') responseFacts.model = o.response.model
      if (o.response.reasoning) responseFacts.reasoning = o.response.reasoning
      if (o.response.usage) responseFacts.usage = o.response.usage
      responseFacts.responseFields = Object.keys(o.response).sort()
    }
  }
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const response = await actualFetch(url as string, { ...init, ...getProxyFetchOptions() } as RequestInit)
    headersMs = Date.now() - started
    if (!response.ok || !response.body) return response
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      const elapsed = Date.now() - started
      firstByteMs ??= elapsed
      chunkTimes.push(elapsed); bytes += chunk.byteLength
      lineBuffer += textDecoder.decode(chunk, { stream: true })
      const lines = lineBuffer.split('\n'); lineBuffer = lines.pop() ?? ''
      for (const line of lines) if (line.startsWith(':')) pings.push(elapsed)
      for (const item of decoder.push(Buffer.from(chunk))) if (item.kind === 'event' && item.event.data !== '[DONE]') {
        try { observe(JSON.parse(item.event.data)) } catch {}
      }
      controller.enqueue(chunk)
    } })), { status: response.status, headers: response.headers })
  }) as typeof fetch
  calls++
  let finish: Extract<OpenaiStreamEvent, { type: 'finish' }> | undefined
  let usage: Extract<OpenaiStreamEvent, { type: 'usage' }>['usage'] | undefined
  let fault: Extract<OpenaiStreamEvent, { type: 'stream-fault' }>['fault'] | undefined
  const mapped: Record<string, number> = {}
  for await (const event of streamOpenaiResponses({ baseUrl: auth!.baseUrl, headers: auth!.headers, request, fetchImpl })) {
    mapped[event.type] = (mapped[event.type] ?? 0) + 1
    if (event.type === 'finish') finish = event
    if (event.type === 'usage') usage = event.usage
    if (event.type === 'stream-fault') fault = event.fault
  }
  const input = usage?.inputTokens ?? 0, cached = usage?.cachedInputTokens ?? 0, written = usage?.cacheWriteInputTokens ?? 0, output = usage?.outputTokens ?? 0
  const estimate = ((Math.max(0, input - cached - written) + cached * 0.05 + written * 1.25) * (input > 272000 ? 2 : 1) + output * 5 * (input > 272000 ? 1.5 : 1)) / 1e6
  totalCost += estimate
  const row = { call: calls, purpose, effort: request.reasoning?.effort, headersMs, firstByteMs, firstDeltaMs, elapsedMs: Date.now() - started, bytes, pingCount: pings.length, pingGapsMs: pings.slice(1).map((t, i) => t - pings[i]!), maxChunkGapMs: Math.max(0, ...chunkTimes.slice(1).map((t, i) => t - chunkTimes[i]!)), eventCounts, eventShapes: shapes, itemShapes, responseFacts, mapped, usage, standardApiEquivalentUsd: estimate, terminal: finish?.reason, unknownItemTypes: finish?.unknownItemTypes, ...(fault ? { fault: { kind: fault.kind, code: fault.code, status: fault.status } } : {}) }
  summaries.push(row)
  console.log(JSON.stringify(row))
  if (fault || !finish) throw new Error('The live request did not complete; no retry was attempted')
  return finish
}
const request = (effort: string, content: string) => buildOpenaiResponsesRequest({ model, instructions: 'Answer the requested synthetic probe accurately.', messages: [{ role: 'user', content }], reasoningEffort: effort })
try {
  await call(request('none', 'Reply OK.'), 'none')
  const toolRequest = buildOpenaiResponsesRequest({ model, instructions: 'Use the supplied tool before answering.', messages: [{ role: 'user', content: 'Load EchoFixture and call it with value ready. Wait for the tool result.' }], reasoningEffort: 'low', tools: [{ name: 'EchoFixture', description: 'Return the supplied fixture value.', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }], deferredToolNames: new Set(['EchoFixture']), toolSearch: true })
  const toolReply = await call(toolRequest, 'hosted-tool-search-and-function')
  assert.equal(toolReply.toolCalls.length, 1)
  assert.equal(toolReply.toolCalls[0]!.name, 'EchoFixture')
  const followup: OpenaiInputItem[] = [...toolRequest.input, ...toolReply.orderedItems, { type: 'function_call_output', call_id: toolReply.toolCalls[0]!.callId, output: 'ready' }]
  await call({ ...toolRequest, input: followup }, 'tool-result-replay')
  const imageRequest = request('medium', 'What color fills the attached square? Answer with its color only.')
  const user = imageRequest.input[0]
  assert.ok(user?.type === 'message')
  user.content.push({ type: 'input_image', image_url: redImage() })
  const image = await call(imageRequest, 'image-input')
  assert.match(image.finalText, /red/i)
  await call(request('high', 'Compute 17 times 23. Answer with the number only.'), 'high')
  await call(request('xhigh', 'Compute 97 times 103. Answer with the number only.'), 'xhigh')
  await call(request('max', 'Determine the exact number of 12-element subsets of the integers 1 through 36 such that no two selected integers are adjacent on the cycle (36 and 1 count as adjacent), and the sum of selected integers is divisible by 7. Develop and cross-check an exact counting method before giving the count and a concise explanation. No tools are available.'), 'long-reasoning')
} finally {
  console.log(JSON.stringify({ calls, standardApiEquivalentUsd: totalCost, accountKind: auth.account.kind, completedCalls: summaries.filter(r => r.terminal !== undefined && r.fault === undefined).length, pricingSource: 'https://developers.openai.com/api/docs/models/gpt-6.1-terra', pricingRead: '2026-10-28' }))
}
process.exit(0)
