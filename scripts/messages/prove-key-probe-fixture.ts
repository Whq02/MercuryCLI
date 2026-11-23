import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const requests: any[] = []
let mode = 'ok'
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    requests.push(await request.json())
    if (mode === 'invalid') return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })
    if (mode === 'other') return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture refusal' } }, { status: 400 })
    return Response.json({ id: 'probe', type: 'message', role: 'assistant', model: requests.at(-1).model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
  },
})
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
process.env.MERCURY_USE_BEDROCK = '0'
process.env.MERCURY_USE_VERTEX = '0'
const { enableConfigs } = await import(`${root}/src/platform/settings/config.ts`)
enableConfigs()
const { verifyApiKey } = await import(`${root}/src/models/roads/anthropic/requestParams.ts`)
try {
  assert.equal(await verifyApiKey('fixture-key', true), true, 'verifyApiKey in src/models/roads/anthropic/requestParams.ts must return true for the headless probe (second argument true)')
  assert.equal(requests.length, 0, 'verifyApiKey in src/models/roads/anthropic/requestParams.ts must send no request when the second argument is true')
  assert.equal(await verifyApiKey('fixture-key', false), true, 'verifyApiKey in src/models/roads/anthropic/requestParams.ts must return true when the fixture server accepts the key')
  assert.equal(requests.length, 1, 'verifyApiKey in src/models/roads/anthropic/requestParams.ts must send exactly one request when the second argument is false')
  assert.equal(requests[0].max_tokens, 1, 'the probe body built in src/models/roads/anthropic/requestParams.ts must set max_tokens to 1')
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'test' }], 'the probe body built in src/models/roads/anthropic/requestParams.ts must carry the one user message test')
  assert.equal(typeof requests[0].metadata.user_id, 'string', 'the probe body built in src/models/roads/anthropic/requestParams.ts must carry metadata.user_id as a string')
  mode = 'invalid'
  assert.equal(await verifyApiKey('fixture-key', false), false, 'verifyApiKey in src/models/roads/anthropic/requestParams.ts must return false on the exact invalid x-api-key authentication error')
  mode = 'other'
  await assert.rejects(() => verifyApiKey('fixture-key', false), /fixture refusal/, 'verifyApiKey in src/models/roads/anthropic/requestParams.ts must rethrow any other API error with its message')
  console.log('PASS headless probe stays local; interactive one-token body, exact invalid-key refusal and other-error propagation hold on loopback')
} finally {
  await server.stop(true)
}
