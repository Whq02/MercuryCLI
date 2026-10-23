#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import type { Message, AssistantMessage } from '../../src/types/message.ts'
import type { CompatStreamEvent, CompatStreamOptions } from '../../src/services/providers/openaicompat/compatChatClient.ts'

pinSourceRef()
const scratch = process.env.MERCURY_CONFIG_DIR
assert.ok(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(join(scratch, 'compat-responses-key-'))
const project = join(home, 'project')
mkdirSync(project)
const previousCwd = process.cwd()
process.chdir(project)
delete process.env.MERCURY_HOME
Object.assign(process.env, { HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true' })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
for (const name of Object.keys(process.env)) if (name.startsWith('MERCURY_COMPAT_')) delete process.env[name]

const wireModel = 'Fixture/Cache'
const captures: Array<{ path: string; raw: string; body: any }> = []
let mode: 'reply' | 'refuse' | 'truncated' = 'reply'
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (req.method === 'GET') return Response.json({ data: [{ id: wireModel }, { id: 'Fixture/Other' }] })
  const raw = await req.text()
  const body = JSON.parse(raw)
  captures.push({ path, raw, body })
  if (mode === 'refuse') return Response.json({ error: { message: 'Invalid fixture request', code: 'invalid_request_error' } }, { status: 400 })
  if (path.endsWith('/chat/completions')) return new Response(
    sse({ model: body.model, choices: [{ delta: { content: 'complete' } }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 10 } } }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
  const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'fixture-signed-reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }
  const message = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'complete', annotations: [] }] }
  return new Response(
    sse({ type: 'response.created', response: { id: 'resp_fixture', model: body.model } }) +
    sse({ type: 'response.output_item.done', item: reasoning }) +
    sse({ type: 'response.output_text.delta', delta: 'complete' }) +
    sse({ type: 'response.output_item.done', item: message }) +
    (mode === 'truncated' ? '' : sse({ type: 'response.completed', response: { output: [reasoning, message], usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 10 } } } })),
    { headers: { 'content-type': 'text/event-stream' } },
  )
} })
const baseUrl = `http://127.0.0.1:${server.port}/v1`
const nativeFetch = globalThis.fetch
const remoteRequests: string[] = []
globalThis.fetch = (async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== new URL(baseUrl).origin) { remoteRequests.push(url.origin); throw new Error('fixture forbids remote requests') }
  return nativeFetch(input, init)
}) as typeof fetch
let failures = 0
function check(name: string, test: () => void): void {
  try { test(); console.log(`[PASS] ${name}`) } catch (error) { failures++; console.log(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`) }
}
try {
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { compatResponsesTransport } = await import('../../src/services/providers/openaicompat/compatResponsesTransport.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { resolveBehaviourContract, stableBehaviourDigest } = await import('../../src/prompt/behaviourContract.ts')
  const { mintCacheDomainKey } = await import('../../src/utils/cache/cacheDomain.ts')
  const { getCwd } = await import('../../src/utils/cwd.ts')
  const systemPrompt = asSystemPrompt(['Stable fixture instructions'])
  const configure = (dialect: 'responses' | 'chat-completions') => {
    assert.equal(updateSettingsForSource('userSettings', { compatProvider: { cache: { baseUrl, dialect, models: [wireModel, 'Fixture/Other'] } } }).error, null)
  }
  async function turn(model = wireModel, messages: Message[] = [createUserMessage({ content: 'Say complete' })], signal = new AbortController().signal): Promise<AssistantMessage[]> {
    const settled: AssistantMessage[] = []
    for await (const row of routedCallModel({ messages, systemPrompt, tools: [], thinkingConfig: { type: 'adaptive' }, signal, options: { model: `compat/cache/${model}`, effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], mcpTools: [], hasAppendSystemPrompt: false } })) {
      if (row.type === 'assistant') settled.push(row)
    }
    return settled
  }

  console.log('routed minting and replay')
  configure('responses')
  const first = await turn()
  const firstCapture = captures.at(-1)!
  const expectedKey = mintCacheDomainKey({ providerScope: 'openai-compat', servedModel: wireModel, projectPath: getCwd(), behaviorContractDigest: stableBehaviourDigest(resolveBehaviourContract([...systemPrompt])), toolSchemaDigest: createHash('sha256').update('[]').digest('hex').slice(0, 16) })
  check('the configured Responses endpoint receives the exact minted key without deferral', () => {
    assert.equal(firstCapture.path, '/v1/responses')
    assert.equal(firstCapture.body.prompt_cache_key, expectedKey)
    assert.ok(firstCapture.raw.includes(`"prompt_cache_key":${JSON.stringify(expectedKey)}`))
  })
  check('the answer and disjoint cached usage settle normally', () => {
    assert.ok(first.length > 0 && first.every(row => !row.isApiErrorMessage))
    assert.equal(first.at(-1)!.message.usage.input_tokens, 10)
    assert.equal(first.at(-1)!.message.usage.cache_read_input_tokens, 10)
    assert.equal(first.at(-1)!.message.usage.output_tokens, 3)
  })
  await turn(wireModel, [createUserMessage({ content: 'Say complete' }), ...first, createUserMessage({ content: 'Continue' })])
  check('continuation preserves the key and signed reasoning replay', () => {
    assert.equal(captures.at(-1)!.body.prompt_cache_key, expectedKey)
    assert.ok(captures.at(-1)!.body.input.some((item: any) => item.encrypted_content === 'fixture-signed-reasoning'))
  })
  configure('chat-completions'); await turn()
  check('chat and Responses forward the same existing mint', () => assert.equal(captures.at(-1)!.body.prompt_cache_key, expectedKey))
  configure('responses'); await turn('Fixture/Other')
  check('a different served model changes the cache domain', () => {
    const key = captures.at(-1)!.body.prompt_cache_key
    assert.equal(typeof key, 'string'); assert.notEqual(key, expectedKey)
  })

  console.log('exact transport bytes and optional field')
  const options: CompatStreamOptions = { url: `${baseUrl}/chat/completions`, request: { model: wireModel, messages: [{ role: 'system', content: 'instructions' }], tools: [{ type: 'function', function: { name: 'FixtureEcho', description: 'Echo fixture', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }], extra: { prompt_cache_key: 'opaque-cache-domain', reasoning_effort: 'max', max_tokens: 128000 } } }
  const messages = [createUserMessage({ content: 'hello' })]
  const expected = { model: wireModel, instructions: 'instructions', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], tools: [{ type: 'function', name: 'FixtureEcho', description: 'Echo fixture', parameters: { type: 'object', properties: { text: { type: 'string' } } } }], reasoning: { effort: 'max' }, max_output_tokens: 128000, prompt_cache_key: 'opaque-cache-domain', include: ['reasoning.encrypted_content'], store: false, stream: true }
  const before = JSON.stringify(options.request)
  async function direct(request = options.request): Promise<CompatStreamEvent[]> {
    const events: CompatStreamEvent[] = []
    for await (const event of compatResponsesTransport({ ...options, request }, messages, 'fixture').events) events.push(event)
    return events
  }
  await direct()
  check('serialized body keeps effort, output ceiling, tools and input byte-for-byte', () => assert.equal(captures.at(-1)!.raw, JSON.stringify(expected)))
  check('forwarding does not mutate the shared request', () => assert.equal(JSON.stringify(options.request), before))
  const { prompt_cache_key: _key, ...extra } = options.request.extra!
  await direct({ ...options.request, extra })
  check('a caller without a key sends no fabricated key', () => {
    const { prompt_cache_key: _expected, ...withoutKey } = expected
    assert.equal(captures.at(-1)!.raw, JSON.stringify(withoutKey))
  })

  console.log('fault and cancellation boundaries')
  mode = 'refuse'
  const refusedAt = captures.length
  const refused = await direct()
  check('a provider refusal remains one refused request', () => {
    assert.equal(captures.length, refusedAt + 1)
    assert.ok(refused.some(event => event.type === 'stream-fault' && event.fault.status === 400))
  })
  mode = 'reply'; await turn()
  check('a served turn after refusal still sends the key', () => assert.equal(captures.at(-1)!.body.prompt_cache_key, expectedKey))
  mode = 'truncated'
  const truncated = await direct()
  check('missing terminal event remains a failure after text', () => {
    assert.ok(truncated.some(event => event.type === 'text-delta'))
    assert.ok(truncated.some(event => event.type === 'stream-fault' && event.fault.code === 'no-terminal-event'))
  })
  const controller = new AbortController(); controller.abort()
  const cancelledAt = captures.length
  assert.deepEqual(await turn(wireModel, undefined, controller.signal), [])
  check('a cancelled routed request sends nothing', () => assert.equal(captures.length, cancelledAt))
  check('the entire proof stays on its loopback fixture', () => assert.deepEqual(remoteRequests, []))
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  process.chdir(previousCwd)
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} compat-responses-cache-key: ${failures} failed`)
process.exit(failures ? 1 : 0)
