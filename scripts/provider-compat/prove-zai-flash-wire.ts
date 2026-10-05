#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { proofHome } from '../lib/hermetic.ts'
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_HOME = proofHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ZAI_API_BASE = 'https://zai.fixture.invalid/v4'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
for (const key of ['ZAI_API_KEY', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_MAX_RETRIES', 'NODE_ENV']) delete process.env[key]

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { writeStoredZaiApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')

let count = 0
const check = (name: string, ok: unknown, detail = ''): void => {
  assert.ok(ok, `${name}${detail ? ` — ${detail}` : ''}`)
  count++
  console.log(`[PASS] ${name}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const posted: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = []
const sseChunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const chatChunks = (model: string): string[] => [
  sseChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }),
  sseChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 19, completion_tokens: 3, total_tokens: 22, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }),
  'data: [DONE]\n\n',
]
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  posted.push({ url, authorization: new Headers(init?.headers).get('authorization'), body })
  if (url.includes('/chat/completions')) return sseResponse(chatChunks(String(body.model ?? 'm')))
  return Response.json({ error: 'unexpected fixture url' }, { status: 404 })
}) as typeof fetch

const user = (content: string): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(modelId: string, effortValue: string | undefined, thinking: boolean): CompatCallModelParams {
  return {
    messages: [user('Reply with the single word OK.')],
    systemPrompt: asSystemPrompt(['Only answer the request.']),
    thinkingConfig: (thinking ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
    tools: [],
    signal: new AbortController().signal,
    options: { model: modelId, querySource: 'agent:builtin:mercury-crew', agentId: 'a-zai-flash-fixture', onWait: () => {}, isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], ...(effortValue !== undefined ? { effortValue } : {}) } as never,
  }
}
async function drive(modelId: string, effortValue: string | undefined, thinking: boolean): Promise<{ body: Record<string, unknown> | undefined; items: unknown[] }> {
  const before = posted.length
  const items: unknown[] = []
  for await (const item of zaiCallModel(params(modelId, effortValue, thinking) as never)) items.push(item)
  return { body: posted.length > before ? posted.at(-1)?.body : undefined, items }
}
const settled = (items: unknown[]): boolean => items.some(item => (item as { type?: string; isApiErrorMessage?: boolean }).type === 'assistant' && (item as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true)

try {
  writeStoredZaiApiKey('zai-fixture-stored-coding-key', 'coding')
  const low = await drive('glm-5.3-flash', 'low', true)
  check('glm-5.3-flash dispatches through the Z.AI road to the fixture base with the bearer key', low.body !== undefined && posted.at(-1)?.url === 'https://zai.fixture.invalid/v4/chat/completions' && posted.at(-1)?.authorization === 'Bearer zai-fixture-stored-coding-key' && settled(low.items), j({ url: posted.at(-1)?.url, body: low.body }))
  check('the plain id rides the wire, never a [1m] suffix', low.body?.model === 'glm-5.3-flash')
  check("the flash dial speaks its own vocabulary: 'low' rides as low", low.body?.reasoning_effort === 'low' && (low.body?.thinking as { type?: string })?.type === 'enabled', j(low.body))
  const max = await drive('glm-5.3-flash', 'max', true)
  check("'max' rides as max", max.body?.reasoning_effort === 'max', j(max.body?.reasoning_effort))
  const xhigh = await drive('glm-5.3-flash', 'xhigh', true)
  check("a level the flash vocabulary lacks steps to the nearest rung below: 'xhigh' rides as high", xhigh.body?.reasoning_effort === 'high', j(xhigh.body?.reasoning_effort))
  const off = await drive('glm-5.3-flash', 'low', false)
  check('with the session thinking off the flash wire still sends thinking enabled (the lock)', (off.body?.thinking as { type?: string })?.type === 'enabled', j(off.body?.thinking))
  const flashx = await drive('glm-5.3-flashx', 'high', false)
  check('glm-5.3-flashx carries the same lock and dial', (flashx.body?.thinking as { type?: string })?.type === 'enabled' && flashx.body?.reasoning_effort === 'high', j(flashx.body))
  const older = await drive('glm-5.2', 'xhigh', false)
  check('glm-5.2 keeps its seven-level dial and the session thinking choice', older.body?.reasoning_effort === 'xhigh' && (older.body?.thinking as { type?: string })?.type === 'disabled', j(older.body))
  const turbo = await drive('glm-5-turbo', 'high', true)
  check('an id with no documented dial rides without one', turbo.body !== undefined && turbo.body.reasoning_effort === undefined && settled(turbo.items), j(turbo.body))
  check('the capability edge and the wire agree on the flash vocabulary', effortVocabularyFor('glm-5.3-flash').kind === 'provider' && (effortVocabularyFor('glm-5.3-flash') as { vocabulary: string[] }).vocabulary.join(',') === 'low,high,max')
  check('no fixture body carries the key', posted.every(call => !JSON.stringify(call.body).includes('zai-fixture-stored-coding-key')))
  console.log(`ZAI FLASH WIRE GREEN (${count} checks; fixture only)`)
} finally {
  rmSync(proofHome, { recursive: true, force: true })
}
