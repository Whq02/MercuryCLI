#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL',
  'MERCURY_SMALL_FAST_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_THINKING_BUDGET',
  'GOOGLE_API_KEY',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-mech-'))

const FIXTURE_PORT = 34111
const STALL_PORT = 34112

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
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — fold mechanical profile prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT, gptReasoningLevels: ['low', 'medium', 'high'] })
Object.assign(process.env, fixture.env)

const stallServer = createServer(() => {
})
await new Promise<void>(resolve => stallServer.listen(STALL_PORT, '127.0.0.1', resolve))

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compactModule = await import('../../src/services/compact/compact.ts')
const { compactConversation } = compactModule
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

const seams = compactModule as Partial<{
  shouldRideCacheSharingFork: (model: string, thinkingConfig?: { type: string }) => boolean
  setFoldBoundsForTests: (bounds: { deadlineMs: number; stallMs: number } | null) => void
  ERROR_MESSAGE_FOLD_TIMEOUT: string
}>

function makeMessages(): unknown[] {
  const user = createUserMessage({ content: 'please bump the version and run the tests' })
  const assistant = {
    type: 'assistant',
    uuid: '00000000-0000-4000-a000-00000000c1de',
    requestId: 'req_m1',
    message: {
      id: 'msg_m1',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [{ type: 'text', text: 'Bumped the version and ran the suite — all green.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
  const user2 = createUserMessage({ content: 'now write the changelog entry' })
  return [user, assistant, user2]
}

type Ctx = { ctx: Record<string, unknown>; readFileState: { size: number }; abort: AbortController }

function makeContext(model: string, opts?: { thinking?: { type: string; budgetTokens?: number } }): Ctx {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'xhigh',
  }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  readFileState.set('/tmp/fold-mech-file.ts', {
    content: 'export const x = 1\n',
    timestamp: Date.now(),
    offset: undefined,
    limit: undefined,
  })
  const abort = new AbortController()
  const ctx = {
    abortController: abort,
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState,
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: model,
      maxThinkingTokens: 0,
      thinkingConfig: opts?.thinking ?? { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  return { ctx, readFileState, abort }
}

type Run = { result?: Record<string, unknown>; error?: Error; hits: typeof fixture.captured; readFileState: { size: number } }

async function runFold(model: string, opts?: { thinking?: { type: string; budgetTokens?: number }; abortAfterMs?: number }): Promise<Run> {
  const before = fixture.captured.length
  const { ctx, readFileState, abort } = makeContext(model, opts)
  if (opts?.abortAfterMs !== undefined) {
    const t = setTimeout(() => abort.abort(), opts.abortAfterMs)
    t.unref?.()
  }
  const messages = makeMessages()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(
      messages as never,
      ctx as never,
      { systemPrompt: asSystemPrompt(['You are a fixture-driven session posture.']) } as never,
      true,
    )) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  return { result, error, hits: fixture.captured.slice(before), readFileState }
}

function effortWordsOf(body: unknown): string[] {
  const words: string[] = []
  const record = body as {
    reasoning_effort?: unknown
    reasoning?: { effort?: unknown }
    output_config?: { effort?: unknown }
    thinking?: unknown
  }
  if (typeof record.reasoning_effort === 'string') words.push(record.reasoning_effort)
  if (record.reasoning && typeof record.reasoning === 'object' && typeof (record.reasoning as { effort?: unknown }).effort === 'string') {
    words.push((record.reasoning as { effort: string }).effort)
  }
  if (record.output_config && typeof record.output_config.effort === 'string') words.push(record.output_config.effort)
  if (typeof record.output_config?.effort === 'number') words.push(String(record.output_config.effort))
  return words
}

const SESSION_TIERS = new Set(['xhigh', 'x-high', 'high', 'medium', 'max'])

section('§1 engine families — the fold wire never carries the session effort tier')
for (const family of [
  { route: 'openai', model: 'gpt-5.5', lane: 'openai-seat' },
  { route: 'zai', model: 'glm-5.2', lane: 'zai-seat' },
]) {
  console.log(`\n  · ${family.route} — session effort xhigh, model ${family.model}`)
  const run = await runFold(family.model)
  check(`${family.route}: the fold resolved`, run.result !== undefined && run.error === undefined, (run.error?.stack ?? '').slice(0, 400))
  check(`${family.route}: the wire saw the fold (count ${run.hits.length} ≥ 1)`, run.hits.length >= 1)
  const words = run.hits.flatMap(h => effortWordsOf(h.body))
  check(
    `${family.route}: no fold hit carries a session effort tier (mechanical 'low' or absent)`,
    words.every(w => !SESSION_TIERS.has(w.toLowerCase())),
    `effort words on the wire: ${j(words)}`,
  )
  check(
    `${family.route}: no fold hit enables provider thinking`,
    run.hits.every(h => {
      const t = (h.body as { thinking?: { type?: string } }).thinking
      return t === undefined || t.type === 'disabled'
    }),
    run.hits.map(h => j((h.body as { thinking?: unknown }).thinking)).join(' | '),
  )
}

section("§2 the home family — output_config.effort is the SESSION's word (the messages cache keys on it), never the mechanical pin")
{
  console.log('\n  · anthropic — session effort xhigh, model claude-opus-4-8')
  const run = await runFold('claude-opus-4-8')
  check('anthropic: the fold resolved', run.result !== undefined && run.error === undefined, (run.error?.stack ?? '').slice(0, 400))
  check(`anthropic: the wire saw the fold (count ${run.hits.length} ≥ 1)`, run.hits.length >= 1)
  const words = run.hits.flatMap(h => effortWordsOf(h.body))
  check(
    "anthropic: every fold hit carries the session's effort tier (a pinned 'low' re-wrote the messages cache on every fold)",
    words.length >= 1 && words.every(w => SESSION_TIERS.has(w.toLowerCase())),
    `effort words on the wire: ${j(words)}`,
  )
}

section('§3 the fork admission is a pure law — home transport only, never a fixed thinking budget')
{
  const gate = seams.shouldRideCacheSharingFork
  check('the fork-admission seam exists (shouldRideCacheSharingFork)', typeof gate === 'function')
  if (typeof gate === 'function') {
    check('home id + disabled thinking ⇒ fork eligible', gate('claude-opus-4-8', { type: 'disabled' }) === true)
    check('home id + adaptive thinking ⇒ fork eligible (the cache key rides)', gate('claude-opus-4-8', { type: 'adaptive' }) === true)
    check('home id + explicit thinking budget ⇒ direct lane', gate('claude-opus-4-8', { type: 'enabled' }) === false)
    check('unrecognised stranger (gateway home ride) ⇒ fork eligible', gate('totally-unknown-model-id', { type: 'disabled' }) === true)
    for (const engine of ['gpt-5.5', 'glm-5.2', 'deepseek-chat', 'kimi-k2-0905-preview', 'openrouter/nvidia/nemotron-nano-9b-v2:free']) {
      check(`engine id ${engine} ⇒ direct mechanical lane, never the fork`, gate(engine, { type: 'disabled' }) === false)
    }
  }
}

section('§4 the deadline — a wedged wire refuses TYPED, the conversation untouched')
{
  const bounds = seams.setFoldBoundsForTests
  const sentence = seams.ERROR_MESSAGE_FOLD_TIMEOUT
  check('the bounds seam exists (setFoldBoundsForTests)', typeof bounds === 'function')
  check('the typed timeout sentence exists (ERROR_MESSAGE_FOLD_TIMEOUT)', typeof sentence === 'string' && sentence.length > 0)
  if (typeof bounds === 'function' && typeof sentence === 'string') {
    const prevBase = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${STALL_PORT}`
    bounds({ deadlineMs: 2_500, stallMs: 800 })
    const run = await runFold('claude-opus-4-8')
    bounds(null)
    process.env.ANTHROPIC_BASE_URL = prevBase
    check('the wedged fold REFUSED (no result)', run.result === undefined)
    check(
      'the refusal is the typed fold-timeout sentence',
      run.error !== undefined && run.error.message === sentence,
      `error: ${run.error?.message ?? '(none)'}`,
    )
    check(
      'the conversation stands untouched (read-file state intact)',
      run.readFileState.size === 1,
      `readFileState.size=${run.readFileState.size}`,
    )
  }
}

section("§5 the operator's abort keeps its own sentence — never dressed as a timeout")
{
  const bounds = seams.setFoldBoundsForTests
  const sentence = seams.ERROR_MESSAGE_FOLD_TIMEOUT
  if (typeof bounds === 'function' && typeof sentence === 'string') {
    const prevBase = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${STALL_PORT}`
    bounds({ deadlineMs: 30_000, stallMs: 20_000 })
    const run = await runFold('claude-opus-4-8', { abortAfterMs: 300 })
    bounds(null)
    process.env.ANTHROPIC_BASE_URL = prevBase
    check('the aborted fold REFUSED (no result)', run.result === undefined)
    check(
      'the abort surfaces as an abort, never the timeout sentence',
      run.error !== undefined && run.error.message !== sentence,
      `error: ${run.error?.message ?? '(none)'}`,
    )
  } else {
    check('abort-vs-timeout distinction provable (seams exist)', false)
  }
}

await fixture.close()
stallServer.closeAllConnections?.()
await new Promise<void>(resolve => stallServer.close(() => resolve()))
clearTimeout(guard)

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ FOLD MECHANICAL PROFILE GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} FOLD MECHANICAL PROFILE FAILURE(S)`)
process.exit(1)
