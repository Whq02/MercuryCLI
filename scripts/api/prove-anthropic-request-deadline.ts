import '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { createServer, type ServerResponse } from 'node:http'
import { AnthropicClient } from '../../src/services/providers/anthropic/anthropicClient.ts'
import { APIConnectionTimeoutError, APIUserAbortError } from '../../src/services/api/sdkErrors.ts'

const responses = new Set<ServerResponse>()
const server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    responses.add(response)
    response.once('close', () => responses.delete(response))
    const path = new URL(request.url!, 'http://fixture.invalid').pathname
    if (path.startsWith('/no-headers')) return
    response.writeHead(path.startsWith('/error-body') ? 400 : 200, { 'content-type': 'application/json' })
    response.flushHeaders()
    if (path.startsWith('/partial-body')) response.write('{"id":')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const base = `http://127.0.0.1:${address.port}`
const body = { model: 'claude-opus-5-5', messages: [{ role: 'user' as const, content: 'resume fixture' }], max_tokens: 64 }
const timeout = 150
let failures = 0
function check(name: string, ok: boolean, facts: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(facts)}`)
  if (!ok) failures++
}
try {
  for (const path of ['no-headers', 'empty-body', 'partial-body', 'error-body']) {
    const client = new AnthropicClient({ baseURL: `${base}/${path}`, apiKey: 'proof-key-ci-gate-not-a-real-key', maxRetries: 0 })
    const abort = new AbortController()
    let proofAborted = false
    const guard = setTimeout(() => { proofAborted = true; abort.abort() }, timeout * 5)
    const start = Date.now()
    let error: unknown
    try { await client.beta.messages.create(body, { timeout, signal: abort.signal }).withResponse() } catch (caught) { error = caught }
    finally { clearTimeout(guard) }
    check(`${path} reaches its request deadline without external cancellation`, !proofAborted && error instanceof APIConnectionTimeoutError && error.requestDeadline === true && Date.now() - start < timeout * 5, { proofAborted, elapsed: Date.now() - start, error: error instanceof Error ? error.name : String(error) })
    const { outageCauseOf } = await import('../../src/services/api/reconnectLadder.ts')
    const { recordTransportFailure } = await import('../../src/services/api/transportEvidence.ts')
    recordTransportFailure(Object.assign(new Error('earlier connection timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
    check(`${path} cannot borrow a connect timeout from the process ring`, outageCauseOf(error) === null, { outage: outageCauseOf(error) })
  }
  const client = new AnthropicClient({ baseURL: `${base}/empty-body`, apiKey: 'proof-key-ci-gate-not-a-real-key', maxRetries: 0 })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 50)
  try { await assert.rejects(client.beta.messages.create(body, { timeout: 500, signal: abort.signal }), APIUserAbortError) }
  finally { clearTimeout(timer) }
  check('operator cancellation remains an operator abort', true, {})
} finally {
  for (const response of responses) response.destroy()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
{
  const { AnthropicStream } = await import('../../src/services/providers/anthropic/anthropicStream.ts')
  const controller = new AbortController()
  let cancelled = false
  let released = false
  const stream = AnthropicStream.fromSSEResponse(new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise<void>(() => {}) },
  })), controller, () => { released = true })
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([pending.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 500) })])
  clearTimeout(timer)
  check('a silent stream releases without awaiting a stuck transport cancellation', settled && cancelled && released, { settled, cancelled, released })
}
{
  let attempts = 0
  const client = new AnthropicClient({
    apiKey: 'proof-key-ci-gate-not-a-real-key', baseURL: 'https://fixture.invalid', maxRetries: 1,
    fetch: (async () => {
      attempts++
      return attempts === 1
        ? new Response(new ReadableStream({ cancel() { return new Promise<void>(() => {}) } }), { status: 503, headers: { 'retry-after': '0' } })
        : Response.json({ id: 'served' })
    }) as typeof fetch,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([client.beta.messages.create(body, { timeout }), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500) })])
  clearTimeout(timer)
  check('retry does not wait for cancellation of the refused response body', result?.id === 'served' && attempts === 2, { attempts, result })
}
{
  const client = new AnthropicClient({ apiKey: 'proof-key-ci-gate-not-a-real-key', baseURL: 'https://fixture.invalid', maxRetries: 0,
    fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const error = await Promise.race([
    client.beta.messages.create(body, { timeout }).then(() => null, error => error),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500) }),
  ])
  clearTimeout(timer)
  check('first-byte timeout settles even when fetch ignores its abort signal', error instanceof APIConnectionTimeoutError, { timeout: error instanceof APIConnectionTimeoutError })
}
assert.equal(failures, 0, 'Anthropic deadlines cover headers and body reads')
