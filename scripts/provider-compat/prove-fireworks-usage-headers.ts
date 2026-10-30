import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import React from 'react'
import { mock } from 'bun:test'
import type { AssistantMessage } from '../../src/types/message.ts'
import { mountOffscreen, settle } from '../lib/settingsPopupHarness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.FIREWORKS_API_KEY = 'proof-key-fireworks-headers-not-a-real-key'
const uncached = 'X-Ratelimit-Limit-Tokens-Uncached-Prompt'
const adjusted = 'X-Ratelimit-Limit-Tokens-Cache-Adjusted-Prompt'
let headers: Record<string, string> = { [uncached]: '9000', [adjusted]: '5000' }
let status = 200
let requests = 0
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/inference/v1/models') return Response.json({ data: [{ id: 'accounts/fireworks/models/gpt-oss-120b', object: 'model', owned_by: 'fireworks' }] })
  assert.equal(path, '/inference/v1/chat/completions')
  assert.equal(req.headers.get('authorization'), `Bearer ${process.env.FIREWORKS_API_KEY}`)
  const body = await req.json() as Record<string, any>
  assert.equal(body.model, 'accounts/fireworks/models/gpt-oss-120b')
  assert.equal(body.stream_options.include_usage, true)
  requests++
  if (status === 429) return Response.json({ error: { code: 'rate_limit_exceeded', message: 'tokens per minute reached' } }, { status, headers })
  const chunk = (delta: unknown, finish_reason: string | null, extra = {}) => `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`
  return new Response(chunk({ content: 'HEADERS-SERVED' }, null) + chunk({}, 'stop') + chunk({}, null, { usage: { prompt_tokens: 8, completion_tokens: 2 } }) + 'data: [DONE]\n\n', { headers: { ...headers, 'content-type': 'text/event-stream' } })
} })
process.env.MERCURY_FIREWORKS_API_BASE = `http://127.0.0.1:${server.port}/inference/v1`
try {
  const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const owner = await import('../../src/services/providers/providerUsage.ts')
  async function run(): Promise<AssistantMessage[]> {
    const rows: AssistantMessage[] = []
    for await (const row of routedCallModel({ messages: [createUserMessage({ content: 'hello' })], systemPrompt: asSystemPrompt(['Fixture']), tools: [], thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, signal: new AbortController().signal, options: { model: 'fireworks/gpt-oss-120b', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' } as never })) {
      if (row.type === 'assistant') rows.push(row as AssistantMessage)
    }
    return rows
  }
  const figures = () => owner.usageForProvider('fireworks').figures?.map(({ key, label, value }) => ({ key, label, value }))
  const uncachedRow = (value: string) => ({ key: uncached.toLowerCase(), label: 'Uncached prompt TPM limit', value })
  const adjustedRow = (value: string) => ({ key: adjusted.toLowerCase(), label: 'Cache-adjusted prompt TPM limit', value })
  const both = await run()
  assert.ok(both.some(row => !row.isApiErrorMessage))
  assert.deepEqual(figures(), [uncachedRow('9000'), adjustedRow('5000')], 'different headers retain different meanings in /usage')
  console.log('[PASS] both headers reach the usage reader with distinct labels and values')

  mock.module('../../src/services/providers/providerUsage.ts', () => ({ ...owner, providerFamilyPresences: () => [{ id: 'fireworks', available: true, credentialed: true, credentialLabel: 'FIREWORKS_API_KEY (env)' }] }))
  const keybindings = await import('../../src/keybindings/useKeybinding.ts')
  mock.module('../../src/keybindings/useKeybinding.ts', () => ({ ...keybindings, useKeybinding: () => undefined }))
  const { Usage } = await import('../../src/components/Settings/Usage.tsx')
  const board = await mountOffscreen(React.createElement(Usage, { width: 116, rowBudget: 44 }), 116, 48)
  try {
    const deadline = Date.now() + 5000
    while (!board.screen().includes('Cache-adjusted prompt TPM limit') && Date.now() < deadline) await settle(10)
    const frame = board.lines().join('\n').replace(/\s+/g, ' ')
    assert.ok(frame.includes('9000 Uncached prompt TPM limit'), frame)
    assert.ok(frame.includes('5000 Cache-adjusted prompt TPM limit'), frame)
    console.log('[PASS] /usage renders the uncached and cache-adjusted readings separately')
  } finally { board.unmount() }

  for (const [next, expected] of [
    [{ [uncached]: '7000' }, [uncachedRow('7000')]],
    [{ [adjusted]: '3000' }, [adjustedRow('3000')]],
    [{}, []],
    [{ [uncached]: '0', [adjusted]: '0' }, [uncachedRow('0'), adjustedRow('0')]],
  ] as Array<[Record<string, string>, Array<{ key: string; label: string; value: string }>]>) {
    headers = next
    const before = requests
    assert.ok((await run()).some(row => !row.isApiErrorMessage))
    assert.equal(requests, before + 1, 'absent or zero readings never gate inference')
    assert.deepEqual(figures(), expected, 'omitted headers do not alias or retain stale values')
  }
  console.log('[PASS] either missing, both missing and zero headers remain informational')
  status = 429
  headers = { [uncached]: '9000', [adjusted]: '5000', 'Retry-After': '3600' }
  const before = requests
  const refused = await run()
  assert.equal(requests, before + 1)
  assert.ok(refused.some(row => row.error === 'rate_limit'))
  assert.ok(JSON.stringify(refused).includes('asks for a 1 h 0 min wait'))
  const reading = owner.usageForProvider('fireworks')
  assert.deepEqual(figures()?.slice(0, 2), [uncachedRow('9000'), adjustedRow('5000')])
  const retry = reading.figures?.find(row => row.key === 'retry')
  assert.equal(retry!.resetsAtMs! - retry!.observedAtMs!, 3_600_000)
  assert.ok(reading.readerNote?.includes('rate limited'))
  status = 200
  headers = {}
  assert.ok((await run()).some(row => !row.isApiErrorMessage))
  assert.equal(requests, before + 2, 'manual retry reaches Fireworks despite the preceding refusal')
  assert.equal(owner.usageForProvider('fireworks').readerNote, undefined)
  assert.deepEqual(figures(), [])
  console.log('[PASS] 429 preserves Retry-After; a served retry clears the refusal and stale readings')
  console.log('FIREWORKS USAGE HEADERS GREEN')
} finally {
  mock.restore()
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
