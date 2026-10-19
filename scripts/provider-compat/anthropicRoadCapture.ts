import { proofHome } from '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import type { Message, AssistantMessage } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const arm = process.argv.at(-1)!
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|MERCURY_)/.test(name) && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE'].includes(name)) delete process.env[name]
}
process.env.MERCURY_CONFIG_DIR = proofHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_ENTRYPOINT = 'sdk-road-proof'
process.env.MERCURY_HOST_CLIENT_APP = 'fixture'
process.env.MERCURY_ADDITIONAL_PROTECTION = '1'
process.env.MERCURY_CACHE_TTL = '5m'
process.env.MERCURY_PROVIDER_HEADERS = 'X-Proof-Header: fixture:exact'
process.env.BROWSER = '/usr/bin/true'
if (arm === 'subscriber') {
  writeFileSync(join(proofHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fixture-subscriber', refreshToken: null, expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile', 'user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x',
  } }))
} else if (arm === 'bearer') {
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-bearer'
} else {
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
}
const turns: ScriptedTurn[] = [
  { kind: 'text', text: 'I can inspect that.', thinking: 'Read the image carefully.', model: 'claude-opus-4-8' },
  { kind: 'tool_use', name: 'FixtureLookup', input: { value: 'é\nquoted "text"' }, id: 'tool_fixture', thinking: 'Look up the value.', model: 'claude-opus-4-8' },
  { kind: 'text', text: 'The value is confirmed.', thinking: 'Use the returned value.', model: 'claude-opus-4-8' },
]
const fixture = await startFixtureApi(turns, { apiChecks: true, jsonForNonStream: true, captureAllHeaders: true })
process.env.ANTHROPIC_BASE_URL = fixture.url
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = fixture.url
const nativeFetch = globalThis.fetch
const loopbackFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== fixture.url) throw new Error(`non-fixture request refused: ${url.origin}`)
  return nativeFetch(input, init)
}
globalThis.fetch = loopbackFetch
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { switchSession } = await import('../../src/bootstrap/state.ts')
const { asSessionId } = await import('../../src/types/ids.ts')
switchSession(asSessionId('11111111-1111-4111-8111-111111111111'))
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getAnthropicClient } = await import('../../src/services/api/client.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { isClaudeAISubscriber } = await import('../../src/utils/auth.ts')
assert.equal(isClaudeAISubscriber(), arm === 'subscriber')
const history: Message[] = [createUserMessage({ content: [
  { type: 'text', text: 'Read this image and then look up its value.' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0S8AAAAASUVORK5CYII=' } },
] })]
const outputs: unknown[] = []
try {
  for (let turn = 0; turn < 3; turn++) {
    const settled: AssistantMessage[] = []
    for await (const event of routedCallModel({
      messages: history, systemPrompt: asSystemPrompt(['You inspect fixture data, then call FixtureLookup.']),
      thinkingConfig: { type: 'enabled' }, tools: [], signal: new AbortController().signal,
      options: {
        model: 'claude-opus-4-8', querySource: 'sdk', isNonInteractiveSession: true,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        agents: [], mcpTools: [], hasAppendSystemPrompt: false, enablePromptCaching: true,
        effortValue: 'max', fetchOverride: loopbackFetch,
        extraToolSchemas: [{ name: 'FixtureLookup', description: 'Read fixture data', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
      },
    })) {
      if (event.type === 'assistant') {
        assert.ok(!event.isApiErrorMessage, JSON.stringify(event))
        settled.push(event)
      }
    }
    assert.ok(settled.length > 0)
    history.push(...settled)
    outputs.push(settled.map(row => row.message))
    if (turn === 0) history.push(createUserMessage({ content: 'Now use FixtureLookup.' }))
    if (turn === 1) history.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: 'confirmed' }] }))
  }
  assert.equal(fixture.refusals.length, 0)
  const requests = fixture.messageRequests()
  assert.equal(requests.length, 3)
  const errors: Record<string, unknown> = {}
  const body = { model: 'claude-opus-4-8', max_tokens: 64, messages: [{ role: 'user', content: 'fixture errors' }] }
  for (const [label, turn, timeout, abort] of [
    ['401', { kind: 'error', status: 401, errorType: 'authentication_error', message: 'fixture credential rejected' }, 1000, false],
    ['429', { kind: 'error', status: 429, errorType: 'rate_limit_error', message: 'fixture wait', headers: { 'retry-after': '0.01', 'anthropic-ratelimit-unified-status': 'allowed' } }, 1000, false],
    ['500', { kind: 'error', status: 500, errorType: 'api_error', message: 'fixture server failure' }, 1000, false],
    ['dropped', { kind: 'die', deltas: ['partial'], gapMs: 10 }, 1000, false],
    ['timeout', { kind: 'stream', blocks: [], gapMs: 0, headerDelayMs: 1000 }, 30, false],
    ['abort', { kind: 'stream', blocks: [], gapMs: 0, headerDelayMs: 1000 }, 1000, true],
  ] as const) {
    const server = await startFixtureApi([turn as ScriptedTurn], { captureAllHeaders: true })
    process.env.ANTHROPIC_BASE_URL = server.url
    const client = await getAnthropicClient({ maxRetries: 0, fetchOverride: (input, init) => {
      assert.equal(new URL(String(input)).origin, server.url)
      return nativeFetch(input, init)
    } })
    const signal = new AbortController()
    const timer = abort ? setTimeout(() => signal.abort(), 30) : undefined
    try {
      const stream = await client.beta.messages.create({ ...body, stream: true } as never, { signal: signal.signal, timeout })
      for await (const _ of stream) {}
      errors[label] = { returned: true }
    } catch (error) {
      const e = error as Error & { status?: number; headers?: Headers }
      errors[label] = { class: e.constructor.name, message: e.message, status: e.status ?? null, retryAfter: e.headers?.get('retry-after') ?? null }
    } finally {
      clearTimeout(timer)
      await server.close()
    }
  }
  console.log('CAPTURE ' + JSON.stringify({ arm, requests, outputs, errors }))
} finally {
  await fixture.close()
}
process.exit(0)
