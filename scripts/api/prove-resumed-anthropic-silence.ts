import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const requests: Array<Record<string, any>> = []
const held = new Set<ServerResponse>()
const server = createServer((request, response) => {
  let text = ''
  request.on('data', chunk => { text += String(chunk) })
  request.on('end', () => {
    if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404); response.end(); return }
    const body = JSON.parse(text)
    requests.push(body)
    held.add(response)
    response.once('close', () => held.delete(response))
    response.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' })
    response.flushHeaders()
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_STREAM_IDLE_TIMEOUT_MS: '1000',
  MERCURY_SILENT_AFTER_HEADERS_MS: '150',
  MERCURY_API_TIMEOUT_MS: '1000',
  MERCURY_MAX_RETRIES: '0',
})
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_DISABLE_NONSTREAMING_FALLBACK', 'MERCURY_BARE']) delete process.env[name]
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage, createUserInterruptionMessage } = await import('../../src/utils/messages.ts')
const first = createAssistantMessage({ content: 'I have read the source.' })
first.message.model = 'claude-opus-5-5'
first.message.stop_reason = 'end_turn'
const messages = [
  createUserMessage({ content: 'inspect the source' }), first,
  createUserInterruptionMessage({ toolUse: false }),
  createUserMessage({ content: '<task-notification><message>Resume the stopped edit.</message></task-notification>' }),
  createUserInterruptionMessage({ toolUse: false }), createUserMessage({ content: 'do as the lead said' }),
]
const parent = new AbortController()
let proofAborted = false
const guard = setTimeout(() => { proofAborted = true; parent.abort() }, 8_000)
const outputs: any[] = []
const started = Date.now()
try {
  for await (const message of routedCallModel({
    messages, tools: [], systemPrompt: ['fixture'] as never,
    thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: parent.signal,
    options: { model: 'claude-opus-5-5', effortValue: 'max', querySource: 'agent:mercury-crew', agentId: 'fixture-stopped-child', isNonInteractiveSession: true,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } as never,
  })) outputs.push(message)
  const errors = outputs.filter(m => m.type === 'assistant' && m.isApiErrorMessage)
  const notices = outputs.filter(m => m.type === 'system' && m.subtype === 'api_error')
  console.log(JSON.stringify({ proofAborted, elapsed: Date.now() - started, requests: requests.map(r => ({ stream: r.stream, model: r.model, effort: r.output_config?.effort, max_tokens: r.max_tokens })), errors: errors.map(m => m.message.content), notices: notices.map(m => m.error?.message) }))
  assert.equal(proofAborted, false, 'a resumed silent request must end on its own deadlines, not the proof guard')
  assert.equal(errors.length, 1, 'the final timeout reaches the caller as one API error')
  assert.match(JSON.stringify(errors[0].message.content), /one non-streamed answer got nothing/)
  assert.ok(notices.some(m => /not one byte after the headers/.test(m.error?.message ?? '')), 'first-byte silence is surfaced before fallback')
  assert.deepEqual(requests.map(r => Boolean(r.stream)), [true, true, false])
  assert.ok(requests.every(r => r.model === 'claude-opus-5-5' && r.output_config?.effort === 'max'))
  assert.ok(requests.every(r => r.thinking !== undefined), 'thinking stays enabled on every attempt')
  assert.equal(requests[0]?.max_tokens, requests[1]?.max_tokens)
  for (const request of requests) {
    assert.equal(request.messages.map((row: any) => row.role).join(','), 'user,assistant,user')
    assert.ok(JSON.stringify(request.messages.at(-1)).includes('Resume the stopped edit.'))
    assert.ok(JSON.stringify(request.messages.at(-1)).includes('do as the lead said'))
  }
  console.log('PASS stopped/resumed Anthropic history alternates and zero-byte streaming plus fallback settles with an error')
} finally {
  clearTimeout(guard)
  parent.abort()
  for (const response of held) response.destroy()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
