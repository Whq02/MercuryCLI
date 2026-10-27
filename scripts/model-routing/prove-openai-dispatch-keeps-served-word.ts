#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AssistantMessage, Message, StreamEvent } from '../../src/types/message.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' OpenAI dispatch — the request keeps the served word when the live list blanks')
console.log('============================================================')

for (const key of ['OPENAI_API_KEY', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_HOME', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-openai-dispatch-served-word-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

const authFile = join(process.env.MERCURY_CONFIG_DIR, '.openai-auth.json')
function landSignIn(tail: string, accountId: string): void {
  const now = Date.now()
  writeFileSync(
    authFile,
    JSON.stringify({
      version: 1,
      tokens: { idToken: `fixture-id-${tail}`, accessToken: `fixture-access-${tail}`, refreshToken: `fixture-refresh-${tail}`, accountId, planType: 'pro', accessTokenExpiresAtMs: now + 86_400_000 },
      lastRefreshMs: now,
      preferredSource: 'chatgpt-subscription',
    }) + '\n',
    { mode: 0o600 },
  )
}

const MODELS_BODY = {
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'medium', visibility: 'list', priority: 1, context_window: 400_000, input_modalities: ['text', 'image'] },
  ],
}
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const REPLY = [
  sse({ type: 'response.created', response: { id: 'resp_served_word' } }),
  sse({ type: 'response.output_text.delta', delta: 'four' }),
  sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'four' }] } }),
  sse({ type: 'response.completed', response: { id: 'resp_served_word', usage: { input_tokens: 10, output_tokens: 2 } } }),
]

let modelsStatus = 200
const modelsCalls: string[] = []
let lastResponsesBody: Record<string, unknown> | undefined
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
  const u = String(url)
  if (u.includes('/models')) {
    modelsCalls.push(init?.headers?.authorization ?? init?.headers?.Authorization ?? '')
    return modelsStatus === 200
      ? new Response(JSON.stringify(MODELS_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('down', { status: modelsStatus, headers: { 'content-type': 'text/plain' } })
  }
  if (u.endsWith('/responses')) {
    lastResponsesBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    return sseResponse(REPLY)
  }
  throw new Error(`unexpected fixture URL: ${u}`)
}) as unknown as typeof fetch

const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.js')
const { __resetOpenaiCatalogueForTest } = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const effort = await import('../../src/utils/effort.js')
const { effortSentOf } = await import('../../src/services/engine-connector/seatProjections.js')

const echoTool = {
  name: 'EchoTool',
  inputSchema: z.object({ text: z.string() }),
  prompt: async () => 'echoes text',
  isReadOnly: () => true,
} as never

async function call(model: string, word: string): Promise<Array<StreamEvent | AssistantMessage>> {
  lastResponsesBody = undefined
  const out: Array<StreamEvent | AssistantMessage> = []
  const params = {
    messages: [{ type: 'user', message: { role: 'user', content: 'add 2+2' }, uuid: 'u1', timestamp: 't' }] as unknown as Message[],
    systemPrompt: ['You are a specialist.'] as unknown as Parameters<typeof openaiCallModel>[0]['systemPrompt'],
    thinkingConfig: { type: 'enabled', budgetTokens: 4096 } as const,
    tools: [echoTool] as unknown as Parameters<typeof openaiCallModel>[0]['tools'],
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model,
      isNonInteractiveSession: true,
      querySource: 'agent:builtin:test' as never,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
      effortValue: word as never,
    } as unknown as Parameters<typeof openaiCallModel>[0]['options'],
  }
  for await (const item of openaiCallModel(params)) out.push(item as StreamEvent | AssistantMessage)
  return out
}
const reasoningOf = (body: Record<string, unknown> | undefined): { effort?: string } | undefined => body?.reasoning as { effort?: string } | undefined
const NOTE = 'live model catalogue is unavailable'

section('§1 a session on account A sends max from the served list')
{
  __resetOpenaiCatalogueForTest()
  landSignIn('a1', 'acct-owner')
  const yielded = await call('gpt-6-astra', 'max')
  check("the request carries reasoning.effort 'max'", reasoningOf(lastResponsesBody)?.effort === 'max', JSON.stringify(lastResponsesBody?.reasoning))
  check('the reply settled with no catalogue note', yielded.some(y => y.type === 'assistant') && !JSON.stringify(yielded).includes(NOTE))
  check("the facts projection reads 'max'", effortSentOf(effort.resolveEffortTruth('gpt-6-astra', 'max')) === 'max')
}

section('§2 the list blanks under the session (another account, its list unreachable): the next request still carries max')
{
  landSignIn('b1', 'acct-other')
  modelsStatus = 500
  const before = modelsCalls.length
  const yielded = await call('gpt-6-astra', 'max')
  check('the dispatch read the list under the new credential and it failed', modelsCalls.length === before + 1 && modelsCalls.at(-1) === 'Bearer fixture-access-b1', JSON.stringify(modelsCalls))
  check("the request still carries reasoning.effort 'max' — the served word, never an omitted key", reasoningOf(lastResponsesBody)?.effort === 'max', JSON.stringify(lastResponsesBody?.reasoning))
  check('the reply settled and carries no sentence claiming the provider default', yielded.some(y => y.type === 'assistant') && !JSON.stringify(yielded).includes(NOTE), JSON.stringify(yielded).slice(0, 400))
  check("the facts projection agrees ('max')", effortSentOf(effort.resolveEffortTruth('gpt-6-astra', 'max')) === 'max')
}

section("§3 a fresh process with no served word keeps today's rule: no key, the note rides")
{
  __resetOpenaiCatalogueForTest()
  landSignIn('c1', 'acct-third')
  const yielded = await call('gpt-6-astra', 'max')
  check('the request carries no reasoning.effort', lastResponsesBody !== undefined && reasoningOf(lastResponsesBody)?.effort === undefined, JSON.stringify(lastResponsesBody?.reasoning))
  check('the note rides the settled reply', JSON.stringify(yielded).includes(NOTE))
  modelsStatus = 200
}

globalThis.fetch = realFetch
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
