import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'tune-provider-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.HOME = home
process.env.USERPROFILE = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let mode: 'complete' | 'unpriced' | 'refuse' | 'cut' | 'cancel' = 'complete'
let onRequest: (() => void) | undefined
const captures: Array<Record<string, unknown>> = []
const text = '{"answer":"hello"}'
const server = createServer(async (request, response) => {
  const buffers: Buffer[] = []
  for await (const chunk of request) buffers.push(Buffer.from(chunk))
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'fixture-think', context_length: 65536 }] }))
    return
  }
  captures.push(JSON.parse(Buffer.concat(buffers).toString()))
  onRequest?.()
  if (mode === 'cancel') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return }
  if (mode === 'refuse') { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture refuses this book' } })); return }
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const base = { id: 'fixture-answer', object: 'chat.completion.chunk', model: 'fixture-think' }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(event({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Provider-side reasoning is separate from the JSON thought.' }, finish_reason: null }] }))
  response.write(event({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }))
  if (mode === 'cut') { response.end(); return }
  response.write(event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  response.end(event({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, ...(mode === 'complete' ? { cost: 0.0123 } : {}) } }) + 'data: [DONE]\n\n')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Fixture did not bind')
process.env.MERCURY_COMPAT_BASE_URL = `http://127.0.0.1:${address.port}/v1`
process.env.MERCURY_COMPAT_API_KEY = 'fixture-not-a-secret'
const realFetch = globalThis.fetch
const fixtureFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1' || url.port !== String(address.port)) throw new Error(`Non-fixture request refused: ${url.origin}`)
  return realFetch(input, init)
}, realFetch)
globalThis.fetch = fixtureFetch
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { completeExternal: callThinkModel } = await import('../../src/services/extensions/complete.js')
  const { noteSessionThinkingConfig } = await import('../../src/utils/thinking.js')
  noteSessionThinkingConfig({ type: 'adaptive' })
  const request = { model: 'compat/fixture-think', system: 'Return the requested thought JSON.', prompt: 'The user asks for a greeting.', episodeId: 'fixture', turn: 0, signal: new AbortController().signal }
  const result = await callThinkModel(request)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.model, 'compat/fixture-think')
  assert.equal(result.costUsd, 0.0123)
  assert.equal(result.inputTokens, 100)
  assert.equal(result.outputTokens, 50)
  assert.ok(result.ok && result.text === text)
  assert.equal(captures[0]!.model, 'fixture-think')
  assert.ok(JSON.stringify(captures[0]!.messages).includes(request.prompt))
  assert.ok(!JSON.stringify(captures[0]!).includes('"thinking":{"type":"disabled"}'))
  assert.ok(captures[0]!.max_tokens === undefined || Number(captures[0]!.max_tokens) > 120)
  console.log('PASS selected compat route reaches loopback, returns complete text, and meters the wire-stated cost')
  mode = 'unpriced'
  const unpriced = await callThinkModel(request)
  assert.ok(unpriced.ok)
  assert.equal(unpriced.costUsd, null)
  assert.equal(unpriced.inputTokens, 100)
  console.log('PASS missing price is not zero; token counts remain')
  mode = 'refuse'
  const refused = await callThinkModel(request)
  assert.ok(!refused.ok)
  assert.match(refused.error, /fixture refuses this book/)
  mode = 'complete'
  assert.ok((await callThinkModel(request)).ok)
  console.log('PASS provider refusal survives and the next request still reaches the selected model')
  mode = 'cut'
  const cut = await callThinkModel(request)
  assert.ok(!cut.ok, JSON.stringify(cut))
  console.log('PASS partial text followed by a stream cut never becomes a kept thought')
  mode = 'cancel'
  const controller = new AbortController()
  onRequest = () => controller.abort()
  const cancelled = await callThinkModel({ ...request, signal: controller.signal })
  assert.ok(!cancelled.ok)
  onRequest = undefined
  mode = 'complete'
  console.log('PASS cancellation reaches the transport and returns no kept thought')
} finally {
  globalThis.fetch = realFetch
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
}
