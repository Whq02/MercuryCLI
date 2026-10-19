import assert from 'node:assert/strict'
import { startFixtureApi, countTokensFixtureFigure } from '../lib/fixtureApi.ts'
import { AnthropicClient } from '../../src/services/providers/anthropic/anthropicClient.ts'
import { AnthropicStream } from '../../src/services/providers/anthropic/anthropicStream.ts'
import { APIError, APIUserAbortError } from '../../src/services/api/sdkErrors.ts'

const body = { model: 'claude-opus-4-8', messages: [{ role: 'user' as const, content: 'fixture transport' }], max_tokens: 64 }
const fixture = await startFixtureApi([
  { kind: 'text', text: 'nonstream answer' },
  { kind: 'error', status: 429, errorType: 'rate_limit_error', message: 'wait', headers: { 'retry-after-ms': '10' } },
  { kind: 'error', status: 500, errorType: 'api_error', message: 'retry', headers: { 'retry-after': '0.01' } },
  { kind: 'text', text: 'retried answer' },
  { kind: 'error', status: 500, errorType: 'api_error', message: 'do not retry', headers: { 'x-should-retry': 'false' } },
  { kind: 'text', text: 'after refusal' },
  { kind: 'error', status: 429, errorType: 'rate_limit_error', message: 'long wait', headers: { 'retry-after': '60' } },
], { jsonForNonStream: true, captureAllHeaders: true, messageHeaders: { 'request-id': 'fixture-request', 'anthropic-workspace-id': 'fixture-workspace' } })
const client = new AnthropicClient({
  baseURL: fixture.url, apiKey: 'fixture-key', maxRetries: 2,
  defaultHeaders: { 'x-extra': 'default', 'anthropic-beta': 'default-beta', 'user-agent': 'fixture' },
})
try {
  const handle = client.beta.messages.create({ ...body, betas: ['first', 'second'], user_profile_id: 'profile-fixture', output_format: { type: 'json_schema', schema: { type: 'object' } } }, { headers: { 'X-Extra': 'request' } })
  const response = await handle.withResponse()
  assert.equal(response.data, await handle)
  assert.equal(response.request_id, 'fixture-request')
  assert.equal((response.data as unknown as { _request_id: string })._request_id, 'fixture-request')
  assert.equal((response.data as unknown as { _workspace_id: string })._workspace_id, 'fixture-workspace')
  assert.ok(!JSON.stringify(response.data).includes('_request_id'))
  const sent = fixture.messageRequests()[0]!
  assert.equal(sent.headers['x-extra'], 'request')
  assert.equal(sent.headers['anthropic-beta'], 'first,second')
  assert.equal(sent.headers['anthropic-user-profile-id'], 'profile-fixture')
  const payload = JSON.parse(sent.raw)
  assert.equal(payload.betas, undefined)
  assert.equal(payload.user_profile_id, undefined)
  assert.equal(payload.output_format, undefined)
  assert.deepEqual(payload.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } })
  assert.throws(() => client.beta.messages.create({ ...body, output_format: {}, output_config: { format: { type: 'json_schema', schema: {} } } }), /Both output_format and output_config.format/)
  const tokens = await client.beta.messages.countTokens({ model: body.model, messages: body.messages, betas: ['first'] })
  const counted = fixture.requests.find(row => row.path.includes('/count_tokens'))!
  assert.equal(counted.headers['anthropic-beta'], 'first,token-counting-2024-11-01')
  assert.equal(tokens.input_tokens, countTokensFixtureFigure(counted.raw))
  const retried = await client.beta.messages.create(body)
  assert.equal(retried.content[0]?.type, 'text')
  assert.equal(fixture.messageRequests().filter(row => !row.path.includes('/count_tokens')).length, 4)
  await assert.rejects(client.beta.messages.create(body).withResponse(), error => error instanceof APIError && error.status === 500 && error.message.includes('do not retry'))
  await client.beta.messages.create(body)
  const signal = new AbortController()
  const waiting = client.beta.messages.create(body, { signal: signal.signal })
  await fixture.messageRequestStarted(7)
  signal.abort()
  await assert.rejects(waiting, APIUserAbortError)
  assert.equal(fixture.messageRequests().filter(row => !row.path.includes('/count_tokens')).length, 7)
  console.log('PASS nonstream IDs, exact header overrides, count-tokens, bounded retries, refusal recovery and cancellation')
} finally {
  await fixture.close()
}

const unicode = await startFixtureApi([{ kind: 'text', text: 'é 𝄞 漢', thinking: 'signed thinking' }])
try {
  const controller = new AbortController()
  const response = await fetch(unicode.url + '/v1/messages', { method: 'POST', body: JSON.stringify({ ...body, stream: true }), headers: { 'content-type': 'application/json' }, signal: controller.signal })
  const raw = new Uint8Array(await response.arrayBuffer())
  const fragmented = new ReadableStream<Uint8Array>({ start(sink) { for (const byte of raw) sink.enqueue(Uint8Array.of(byte)); sink.close() } })
  const stream = AnthropicStream.fromSSEResponse(new Response(fragmented), controller)
  const parts = []
  for await (const part of stream) parts.push(part)
  assert.ok(parts.some(part => part.type === 'content_block_delta' && part.delta.type === 'text_delta' && part.delta.text === 'é 𝄞 漢'))
  assert.ok(parts.some(part => part.type === 'content_block_delta' && part.delta.type === 'signature_delta' && part.delta.signature === 'fixture-signature'))
  assert.equal(parts.at(-1)?.type, 'message_stop')
  assert.equal(controller.signal.aborted, true)
  console.log('PASS single-byte UTF-8 stream fragmentation, signed thinking, terminal event and resource release')
} finally {
  await unicode.close()
}
