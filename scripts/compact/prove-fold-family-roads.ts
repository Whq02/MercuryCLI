#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(MODEL|SMALL_FAST_MODEL|AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_OAUTH_TOKEN|MERCURY_SCRIPTED_STREAM|MERCURY_SIMPLE|MERCURY_MAX_OUTPUT_TOKENS|MERCURY_HOME|MERCURY_EFFORT_LEVEL|MAX_THINKING_TOKENS|MERCURY_COMPACT_KEEP_TAIL|MERCURY_AUTOCOMPACT_PCT_OVERRIDE|MERCURY_BLOCKING_LIMIT_OVERRIDE|MERCURY_DISABLE_1M_CONTEXT|DISABLE_COMPACT|DISABLE_AUTO_COMPACT|MERCURY_CTX_COMPACTION|MERCURY_THINKING_BINDING)$/.test(key) ||
    /^(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|HF)_/.test(key) ||
    /^HF_TOKEN$/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|OPENROUTER|HUGGINGFACE|COMPAT|LOCAL)_/.test(key)
  ) {
    delete process.env[key]
  }
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-roads-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const DUMP_DIR = mkdtempSync(join(tmpdir(), 'fold-roads-dump-'))
process.env.MERCURY_WIRE_DUMP = DUMP_DIR

const SHARED_PORT = 34131
const CENSUS_PORT = 34132
const PACED_PORT = 34133

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function note(label: string): void {
  console.log(`  [NOTE] ${label}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — fold family roads prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const { startFoldFamiliesFixture } = await import('./foldFamiliesFixture.ts')
const shared = await startCrossfamilyFixture({ port: SHARED_PORT, gptReasoningLevels: ['low', 'medium', 'high'] })
const census = await startFoldFamiliesFixture({ port: CENSUS_PORT })
Object.assign(process.env, shared.env, census.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compactModule = await import('../../src/services/compact/compact.ts')
const { compactConversation, shouldRideCacheSharingFork, foldFamilyOf, setFoldBoundsForTests, buildPostCompactMessages } = compactModule
const { classifyModelRoute, laneLabelForVerdict } = await import('../../src/services/providers/routeLaw.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { getModelMaxOutputTokens, resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
await refreshLocalDiscovery({ force: true })

const POSTURE_MARK = 'fixture-driven session posture'
const SESSION_TIERS = new Set(['xhigh', 'x-high', 'high', 'medium', 'max', 'ultra'])

let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`

function assistantRow(text: string, extra: Record<string, unknown> = {}, model = 'fixture'): unknown {
  const id = `msg_${nextUuid().slice(-6)}`
  return {
    type: 'assistant',
    uuid: nextUuid(),
    requestId: `req_${id}`,
    timestamp: new Date().toISOString(),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    ...extra,
  }
}

function makeMessages(): unknown[] {
  return [
    createUserMessage({ content: 'please bump the version and run the tests' }),
    assistantRow('Bumped the version and ran the suite — all green.'),
    createUserMessage({ content: 'now write the changelog entry' }),
  ]
}

type Ctx = { ctx: Record<string, unknown>; readFileState: { size: number }; abort: AbortController }

function makeContext(model: string, opts?: { thinking?: { type: string } }): Ctx {
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
  readFileState.set('/tmp/fold-roads-file.ts', { content: 'export const x = 1\n', timestamp: Date.now(), offset: undefined, limit: undefined })
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

type Run = { result?: Record<string, unknown>; error?: Error; readFileState: { size: number }; ms: number }

async function runFold(model: string, road: 'direct' | 'fork', messages: unknown[] = makeMessages(), opts?: { thinking?: { type: string } }, parts?: { systemPrompt: unknown; systemContext: Record<string, string> }): Promise<Run> {
  const { ctx, readFileState } = makeContext(model, opts)
  if (parts !== undefined) {
    const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
    const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
    ;(ctx.options as Record<string, unknown>).tools = [FileReadTool, ToolSearchTool]
  }
  const cacheSafe =
    road === 'direct'
      ? parts !== undefined
        ? { systemPrompt: parts.systemPrompt, systemContext: parts.systemContext }
        : { systemPrompt: asSystemPrompt([`You are a ${POSTURE_MARK}.`]) }
      : { systemPrompt: asSystemPrompt([`You are a ${POSTURE_MARK}.`]), userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: messages }
  const startedAt = Date.now()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(messages as never, ctx as never, cacheSafe as never, true)) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  return { result, error, readFileState, ms: Date.now() - startedAt }
}

function deepHas(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(v => deepHas(v, key))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (key in record) return true
    return Object.values(record).some(v => deepHas(v, key))
  }
  return false
}
function effortWordsOf(body: unknown): string[] {
  const words: string[] = []
  const record = body as { reasoning_effort?: unknown; reasoning?: { effort?: unknown }; output_config?: { effort?: unknown }; thinking?: { reasoning_effort?: unknown } }
  if (typeof record.reasoning_effort === 'string') words.push(record.reasoning_effort)
  if (record.reasoning && typeof record.reasoning === 'object' && typeof record.reasoning.effort === 'string') words.push(record.reasoning.effort)
  if (record.output_config && typeof record.output_config.effort === 'string') words.push(record.output_config.effort)
  if (record.thinking && typeof record.thinking === 'object' && typeof record.thinking.reasoning_effort === 'string') words.push(record.thinking.reasoning_effort)
  return words
}
type Cap = { key: string; value: number } | null
function outputCapOf(body: unknown): Cap {
  const record = body as Record<string, unknown>
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (typeof record[key] === 'number') return { key, value: record[key] as number }
  }
  return null
}
type Shape = {
  effort: string[]
  thinking: unknown
  cap: Cap
  cacheControl: boolean
  outputConfig: boolean
  reasoningObject: boolean
  reasoningEffortKey: boolean
  store: unknown
  include: unknown
  streamOptions: boolean
  contextManagement: boolean
  posture: boolean
  maxOutputTokens: boolean
}
function shapeOf(body: unknown): Shape {
  const record = body as Record<string, unknown>
  return {
    effort: effortWordsOf(body),
    thinking: record.thinking,
    cap: outputCapOf(body),
    cacheControl: deepHas(body, 'cache_control'),
    outputConfig: record.output_config !== undefined,
    reasoningObject: record.reasoning !== undefined && typeof record.reasoning === 'object',
    reasoningEffortKey: record.reasoning_effort !== undefined,
    store: record.store,
    include: record.include,
    streamOptions: record.stream_options !== undefined,
    contextManagement: record.context_management !== undefined && record.context_management !== null,
    posture: j(body).includes(POSTURE_MARK),
    maxOutputTokens: record.max_output_tokens !== undefined,
  }
}

section('§1 the route verdict per family, pure — fork or direct, and the family word')
{
  const LEGS: Array<{ id: string; family: string; road: 'fork' | 'direct'; label: string }> = [
    { id: 'claude-opus-4-8', family: 'anthropic', road: 'fork', label: 'Anthropic' },
    { id: 'gpt-5.5', family: 'openai', road: 'direct', label: 'OpenAI' },
    { id: 'glm-5.2', family: 'zai', road: 'direct', label: 'Z.AI' },
    { id: 'kimi-k2-0905-preview', family: 'moonshot', road: 'direct', label: 'Moonshot' },
    { id: 'moonshot-v1-8k', family: 'moonshot', road: 'direct', label: 'Moonshot' },
    { id: 'deepseek-chat', family: 'deepseek', road: 'direct', label: 'DeepSeek' },
    { id: 'gemini-2.5-pro', family: 'gemini', road: 'direct', label: 'Gemini' },
    { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', family: 'huggingface', road: 'direct', label: 'Hugging Face' },
    { id: 'openrouter/nvidia/nemotron-nano-9b-v2:free', family: 'openrouter', road: 'direct', label: 'OpenRouter' },
    { id: 'compat/census-endpoint-model', family: 'openai-compat', road: 'direct', label: 'Custom endpoint' },
    { id: 'local/census-local-model', family: 'local', road: 'direct', label: 'Local models' },
    { id: 'totally-unknown-model-id', family: 'unrecognised', road: 'fork', label: 'Unrecognised' },
    { id: 'anthropic/claude-opus-5', family: 'unrecognised', road: 'fork', label: 'Unrecognised' },
    { id: '', family: 'absence', road: 'direct', label: 'unset' },
  ]
  for (const leg of LEGS) {
    const road = shouldRideCacheSharingFork(leg.id, { type: 'disabled' }) ? 'fork' : 'direct'
    check(`${leg.family} (${leg.id || 'no id'}): rides the ${leg.road} road`, road === leg.road, `rode ${road}`)
    check(`${leg.family} (${leg.id || 'no id'}): the fold row's family word is the classifier's`, foldFamilyOf(leg.id) === leg.family, foldFamilyOf(leg.id))
    check(`${leg.family} (${leg.id || 'no id'}): the lane label is the family's own display name`, laneLabelForVerdict(classifyModelRoute(leg.id)) === leg.label, laneLabelForVerdict(classifyModelRoute(leg.id)))
  }
  check('a home id under an explicit fixed thinking budget rides the direct lane', shouldRideCacheSharingFork('claude-opus-4-8', { type: 'enabled' }) === false)
  check('a home id under adaptive thinking still rides the fork (the cache key rides)', shouldRideCacheSharingFork('claude-opus-4-8', { type: 'adaptive' }) === true)
  check('an unrecognised stranger under a fixed thinking budget rides the direct lane', shouldRideCacheSharingFork('totally-unknown-model-id', { type: 'enabled' }) === false)
}

section('§2 the request shape per family — the mechanical profile in each family\'s own spelling, no other family\'s field')
type Expect = {
  effort: 'low' | 'absent' | 'session'
  thinking: 'off' | 'disabled-object'
  cap: 'max_tokens' | 'max_completion_tokens' | 'none'
  cacheControl: boolean
  outputConfig: boolean
  reasoningObject: boolean
  reasoningEffortKey: boolean
  storeInclude: boolean
  streamOptions: boolean | null
}
type Leg = { family: string; model: string; fixture: 'shared' | 'census'; lane: string; road: 'direct' | 'fork'; expect: Expect }
const OFF = { cacheControl: false, outputConfig: false, reasoningObject: false, reasoningEffortKey: false, storeInclude: false }
const LEGS: Leg[] = [
  { family: 'anthropic', model: 'claude-opus-4-8', fixture: 'shared', lane: 'anthropic-seat', road: 'direct', expect: { effort: 'session', thinking: 'off', cap: 'max_tokens', cacheControl: true, outputConfig: true, reasoningObject: false, reasoningEffortKey: false, storeInclude: false, streamOptions: null } },
  { family: 'anthropic', model: 'claude-opus-4-8', fixture: 'shared', lane: 'anthropic-seat', road: 'fork', expect: { effort: 'session', thinking: 'off', cap: 'max_tokens', cacheControl: true, outputConfig: true, reasoningObject: false, reasoningEffortKey: false, storeInclude: false, streamOptions: null } },
  { family: 'openai', model: 'gpt-5.5', fixture: 'shared', lane: 'openai-seat', road: 'direct', expect: { ...OFF, effort: 'low', thinking: 'off', cap: 'none', reasoningObject: true, storeInclude: true, streamOptions: null } },
  { family: 'zai', model: 'glm-5.2', fixture: 'shared', lane: 'zai-seat', road: 'direct', expect: { ...OFF, effort: 'low', thinking: 'disabled-object', cap: 'max_tokens', reasoningEffortKey: true, streamOptions: null } },
  { family: 'openrouter', model: 'openrouter/nvidia/nemotron-nano-9b-v2:free', fixture: 'shared', lane: 'openrouter-seat', road: 'direct', expect: { ...OFF, effort: 'absent', thinking: 'off', cap: 'max_tokens', streamOptions: true } },
  { family: 'moonshot', model: 'kimi-k2-0905-preview', fixture: 'census', lane: 'moonshot', road: 'direct', expect: { ...OFF, effort: 'absent', thinking: 'off', cap: 'max_completion_tokens', streamOptions: true } },
  { family: 'deepseek', model: 'deepseek-chat', fixture: 'census', lane: 'deepseek', road: 'direct', expect: { ...OFF, effort: 'absent', thinking: 'disabled-object', cap: 'max_tokens', streamOptions: true } },
  { family: 'gemini', model: 'gemini-2.5-pro', fixture: 'census', lane: 'gemini', road: 'direct', expect: { ...OFF, effort: 'absent', thinking: 'off', cap: 'max_tokens', streamOptions: true } },
  { family: 'huggingface', model: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', fixture: 'census', lane: 'huggingface', road: 'direct', expect: { ...OFF, effort: 'absent', thinking: 'off', cap: 'max_tokens', streamOptions: true } },
  { family: 'openai-compat', model: 'compat/census-endpoint-model', fixture: 'census', lane: 'openai-compat', road: 'direct', expect: { ...OFF, effort: 'absent', thinking: 'off', cap: 'max_tokens', streamOptions: true } },
  { family: 'local', model: 'local/census-local-model', fixture: 'census', lane: 'local', road: 'direct', expect: { ...OFF, effort: 'low', thinking: 'off', cap: 'max_tokens', reasoningEffortKey: true, streamOptions: true } },
]
const shapes: Array<{ family: string; road: string; shape: Shape }> = []
for (const leg of LEGS) {
  console.log(`\n  · ${leg.family}/${leg.road} — ${leg.model}`)
  const captured = leg.fixture === 'shared' ? shared.captured : census.captured
  const before = captured.length
  const run = await runFold(leg.model, leg.road)
  const hits = captured.slice(before).filter(h => h.lane === leg.lane)
  const stray = captured.slice(before).filter(h => h.lane !== leg.lane)
  check(`${leg.family}/${leg.road}: the fold resolved (${run.ms} ms)`, run.result !== undefined && run.error === undefined, (run.error?.message ?? '').slice(0, 300))
  check(`${leg.family}/${leg.road}: the wire saw the fold on its own lane only`, hits.length >= 1 && stray.length === 0, `${hits.length} on ${leg.lane}; stray ${stray.map(h => h.lane).join(',')}`)
  if (hits.length === 0) continue
  const body = hits[hits.length - 1]!.body
  const shape = shapeOf(body)
  shapes.push({ family: leg.family, road: leg.road, shape })
  const e = leg.expect
  check(`${leg.family}/${leg.road}: the session's own posture rides the wire`, shape.posture)
  if (e.effort === 'session') {
    check(`${leg.family}/${leg.road}: effort is the SESSION's own word (the messages cache keys on it) — never the mechanical 'low'`, shape.effort.length >= 1 && shape.effort.every(w => w !== 'low' && SESSION_TIERS.has(w)), j(shape.effort))
  } else {
    check(`${leg.family}/${leg.road}: effort ${e.effort === 'low' ? "is the mechanical word 'low' in the family's spelling" : 'has no dial (this row states no reasoning vocabulary; §2b seeds one)'} — never the session tier`, e.effort === 'low' ? shape.effort.length >= 1 && shape.effort.every(w => w === 'low') : shape.effort.length === 0, j(shape.effort))
  }
  const thinking = shape.thinking as { type?: string } | undefined
  check(
    `${leg.family}/${leg.road}: thinking ${e.thinking === 'off' ? 'is off the wire (absent or disabled)' : "rides as the family's own disabled object"}`,
    e.thinking === 'off' ? thinking === undefined || thinking.type === 'disabled' : thinking !== undefined && typeof thinking === 'object' && thinking.type === 'disabled',
    j(shape.thinking),
  )
  const expectedCap = Math.min(20_000, getModelMaxOutputTokens(leg.model).upperLimit)
  if (e.cap === 'none') {
    check(`${leg.family}/${leg.road}: no output cap on this wire (the Responses road bounds server-side)`, shape.cap === null, j(shape.cap))
  } else if (leg.road === 'fork') {
    check(`${leg.family}/${leg.road}: the output cap is the family's ${e.cap} (the fork never clamps: no override)`, shape.cap !== null && shape.cap.key === e.cap && shape.cap.value > 0, j(shape.cap))
  } else {
    check(`${leg.family}/${leg.road}: the output cap is ${e.cap} = min(20,000, the model's ceiling) = ${expectedCap}`, shape.cap !== null && shape.cap.key === e.cap && shape.cap.value === expectedCap, j(shape.cap))
  }
  check(`${leg.family}/${leg.road}: max_output_tokens never rides any wire`, !shape.maxOutputTokens)
  check(`${leg.family}/${leg.road}: cache_control ${e.cacheControl ? 'rides (the home prefix cache)' : 'is ABSENT (another family\'s field)'}`, shape.cacheControl === e.cacheControl)
  check(`${leg.family}/${leg.road}: output_config ${e.outputConfig ? 'rides' : 'is ABSENT'}`, shape.outputConfig === e.outputConfig)
  check(`${leg.family}/${leg.road}: the Responses reasoning object ${e.reasoningObject ? 'rides' : 'is ABSENT'}`, shape.reasoningObject === e.reasoningObject)
  check(`${leg.family}/${leg.road}: the chat reasoning_effort key ${e.reasoningEffortKey ? 'rides' : 'is ABSENT'}`, shape.reasoningEffortKey === e.reasoningEffortKey)
  check(`${leg.family}/${leg.road}: store/include ${e.storeInclude ? 'ride (stateless replay with encrypted reasoning)' : 'are ABSENT'}`, e.storeInclude ? shape.store === false && Array.isArray(shape.include) && shape.include.includes('reasoning.encrypted_content') : shape.store === undefined && shape.include === undefined, j({ store: shape.store, include: shape.include }))
  if (e.streamOptions !== null) check(`${leg.family}/${leg.road}: stream_options.include_usage rides the chat wire`, shape.streamOptions === e.streamOptions)
  check(`${leg.family}/${leg.road}: no server-side context edits ride (context_management)`, !shape.contextManagement)
}
section("§2c the home wire that serves per-message effort (Claude Fable 5.1 — measured: the whole prefix read under the row): the session's word top-level, the mechanical pin as a row, the beta with it")
{
  const { MID_CONVERSATION_OUTPUT_CONFIG_BETA_HEADER } = await import('../../src/constants/betas.ts')
  for (const road of ['fork', 'direct'] as const) {
    const before = shared.captured.length
    const run = await runFold('claude-fable-5-1', road)
    const hits = shared.captured.slice(before).filter(h => h.lane === 'anthropic-seat')
    check(`fable-5-1/${road}: the fold resolved and reached the home wire`, run.error === undefined && hits.length >= 1, (run.error?.message ?? '').slice(0, 200))
    const body = (hits[hits.length - 1]?.body ?? {}) as { messages?: Array<{ role?: string; content?: unknown; output_config?: { effort?: string } }>; output_config?: { effort?: string } }
    const rows = body.messages ?? []
    const effortRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.role === 'system')
    check(`fable-5-1/${road}: the top-level effort is the SESSION's word (never the pin)`, typeof body.output_config?.effort === 'string' && body.output_config.effort !== 'low' && SESSION_TIERS.has(body.output_config.effort), j(body.output_config))
    check(`fable-5-1/${road}: exactly one per-message effort row rides — no content, the mechanical 'low'`, effortRows.length === 1 && Array.isArray(effortRows[0]!.r.content) && effortRows[0]!.r.content.length === 0 && effortRows[0]!.r.output_config?.effort === 'low', j(effortRows))
    const lastUser = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.role === 'user').pop()
    check(`fable-5-1/${road}: the row sits right before the last user row (the summariser prompt)`, lastUser !== undefined && effortRows[0]?.i === lastUser.i - 1, `row ${effortRows[0]?.i} last user ${lastUser?.i}`)
    const betas = String((hits[hits.length - 1] as { headers?: Record<string, string> })?.headers?.['anthropic-beta'] ?? (hits[hits.length - 1] as { betas?: string })?.betas ?? '')
    console.log(`  [record] fable-5-1/${road}: the beta header as the wire saw it: ${betas || '(the fixture records no headers)'}`)
    if (betas !== '') check(`fable-5-1/${road}: the per-message effort beta rides the header`, betas.includes(MID_CONVERSATION_OUTPUT_CONFIG_BETA_HEADER))
  }
  const before = shared.captured.length
  await runFold('claude-opus-4-8', 'direct')
  const plain = (shared.captured.slice(before).filter(h => h.lane === 'anthropic-seat').pop()?.body ?? {}) as { messages?: Array<{ role?: string }> }
  check('opus-4-8/direct: no per-message row where the wire does not serve it', !(plain.messages ?? []).some(r => r.role === 'system'))
}

section("§2d Claude Opus 5 — measured: the row costs it the whole prefix (0 read, 63,865 written) — so NO row rides and the session's word is the request's")
{
  for (const road of ['fork', 'direct'] as const) {
    const before = shared.captured.length
    const run = await runFold('claude-opus-5', road)
    const hits = shared.captured.slice(before).filter(h => h.lane === 'anthropic-seat')
    check(`opus-5/${road}: the fold resolved and reached the home wire`, run.error === undefined && hits.length >= 1, (run.error?.message ?? '').slice(0, 200))
    const body = (hits[hits.length - 1]?.body ?? {}) as { messages?: Array<{ role?: string }>; output_config?: { effort?: string } }
    const effortRows = (body.messages ?? []).filter(r => r.role === 'system')
    check(`opus-5/${road}: no per-message effort row rides (the wire taught)`, effortRows.length === 0, `${effortRows.length} row(s)`)
    check(`opus-5/${road}: the top-level effort is the SESSION's word (the cache keys on it)`, typeof body.output_config?.effort === 'string' && SESSION_TIERS.has(body.output_config.effort), j(body.output_config))
  }
}

section("§8 the OpenAI road: the fold's request IS the session's last request plus the summariser prompt")
{
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
  const { appendSystemContext } = await import('../../src/utils/api.ts')
  const model = 'gpt-5.5'
  const pool = [FileReadTool, ToolSearchTool]
  const { ctx } = makeContext(model)
  ;(ctx.options as Record<string, unknown>).tools = pool
  const posture = asSystemPrompt([`You are a ${POSTURE_MARK}.`])
  const systemContext = { gitStatus: 'clean' }
  const messages = makeMessages()
  const before = shared.captured.length
  const sessionStream = routedCallModel({
    messages: messages as never,
    systemPrompt: asSystemPrompt(appendSystemContext([...posture], systemContext)),
    thinkingConfig: { type: 'disabled' },
    tools: pool as never,
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: () => Promise.resolve((ctx.getAppState as () => { toolPermissionContext: unknown })().toolPermissionContext as never),
      model,
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      querySource: 'repl_main_thread' as never,
      agents: [],
      mcpTools: [],
      effortValue: 'xhigh' as never,
    } as never,
  })
  for await (const _event of sessionStream) {
  }
  const sessionHits = shared.captured.slice(before).filter(h => h.lane === 'openai-seat')
  check('§8: the session request reached the OpenAI wire', sessionHits.length === 1, `${sessionHits.length}`)
  const foldFrom = shared.captured.length
  const run = await runFold(model, 'direct', messages, undefined, { systemPrompt: posture, systemContext })
  const foldHits = shared.captured.slice(foldFrom).filter(h => h.lane === 'openai-seat')
  check('§8: the fold resolved and reached the same wire', run.error === undefined && foldHits.length >= 1, (run.error?.message ?? '').slice(0, 200))
  const sessionBody = (sessionHits[0]?.body ?? {}) as { instructions?: string; tools?: unknown[]; prompt_cache_key?: string; input?: unknown[] }
  const foldBody = (foldHits[foldHits.length - 1]?.body ?? {}) as { instructions?: string; tools?: unknown[]; prompt_cache_key?: string; input?: unknown[] }
  check("§8: the fold's instructions are the session's byte-for-byte (the posture WITH its context tail)", typeof foldBody.instructions === 'string' && foldBody.instructions === sessionBody.instructions && foldBody.instructions.includes('gitStatus: clean'), `fold ${foldBody.instructions?.length} chars vs session ${sessionBody.instructions?.length}`)
  console.log(`  [record] §8 session tools: ${j(sessionBody.tools).slice(0, 400)}`)
  console.log(`  [record] §8 fold tools:    ${j(foldBody.tools).slice(0, 400)}`)
  console.log(`  [record] §8 session items: ${j((sessionBody.input ?? []).map(it => ({ ...(it as Record<string, unknown>), content: j((it as { content?: unknown }).content).slice(0, 120) }))).slice(0, 1200)}`)
  console.log(`  [record] §8 fold items:    ${j((foldBody.input ?? []).map(it => ({ ...(it as Record<string, unknown>), content: j((it as { content?: unknown }).content).slice(0, 120) }))).slice(0, 1200)}`)
  check("§8: the fold's tools are the session's pool, byte-for-byte", j(foldBody.tools) === j(sessionBody.tools) && (foldBody.tools?.length ?? 0) >= 1, `fold ${foldBody.tools?.length} vs session ${sessionBody.tools?.length}`)
  check("§8: the fold's prompt_cache_key equals the session's — the prefix hits by construction", typeof foldBody.prompt_cache_key === 'string' && foldBody.prompt_cache_key === sessionBody.prompt_cache_key, `${foldBody.prompt_cache_key} vs ${sessionBody.prompt_cache_key}`)
  const sessionItems = sessionBody.input ?? []
  const foldItems = foldBody.input ?? []
  const textOf = (item: unknown): string => {
    const content = (item as { content?: unknown }).content
    if (typeof content === 'string') return content
    return Array.isArray(content) ? content.map(b => String((b as { text?: string }).text ?? '')).join('\n') : ''
  }
  const sameHead = j(foldItems.slice(0, sessionItems.length - 1)) === j(sessionItems.slice(0, -1))
  const lastSession = sessionItems[sessionItems.length - 1]
  const lastFold = foldItems[sessionItems.length - 1]
  const lastCarries = lastSession !== undefined && lastFold !== undefined && textOf(lastFold).startsWith(textOf(lastSession)) && textOf(lastFold).length > textOf(lastSession).length
  check("§8: the fold's input is the session's items with the summariser prompt appended (merged into the last user item, the head byte-identical)", foldItems.length === sessionItems.length && sameHead && lastCarries, `fold ${foldItems.length} items vs session ${sessionItems.length}; head ${sameHead}; last ${lastCarries}`)
}

console.log('\n  the census as the wire saw it:')
for (const row of shapes) {
  const s = row.shape
  console.log(`    ${row.family.padEnd(14)} ${row.road.padEnd(6)} effort=${j(s.effort)} thinking=${j(s.thinking)} cap=${s.cap ? `${s.cap.key}:${s.cap.value}` : 'none'} cache_control=${s.cacheControl} output_config=${s.outputConfig} reasoning=${s.reasoningObject} reasoning_effort=${s.reasoningEffortKey} store=${j(s.store)} stream_options=${s.streamOptions}`)
}

section("§2b the thinking-off word on the wire — a fold on a Gemini thinking row or an OpenRouter reasoning row sends the family's lowest word, never silence")
{
  const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
  const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
  const jsonFetch = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  gemini.__resetGeminiCatalogueForTest()
  await gemini.refreshGeminiCatalogue('api-key', {
    force: true,
    fetchImpl: jsonFetch({ models: [{ name: 'models/gemini-fixture-pro', displayName: 'Gemini Fixture Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'], thinking: true }] }),
  })
  openrouter.__resetOpenrouterCatalogueForTest()
  await openrouter.refreshOpenrouterCatalogue('env', {
    force: true,
    fetchImpl: jsonFetch({
      data: [
        { id: 'stealth/ox-alpha', name: 'Ox Alpha', context_length: 1_048_576, supported_parameters: ['reasoning', 'tools', 'tool_choice', 'max_tokens'], reasoning: { supported_efforts: ['none', 'low', 'medium', 'high'] } },
        { id: 'stealth/ox-tall', name: 'Ox Tall', context_length: 1_048_576, supported_parameters: ['reasoning', 'tools', 'tool_choice', 'max_tokens'], reasoning: { supported_efforts: ['high', 'max'] } },
      ],
      total_count: 2,
      links: { next: null },
    }),
  })
  check('the seeded Gemini row states a thinking model (the dial exists)', gemini.geminiEffortVocabularyFor('gemini-fixture-pro').length > 0)
  check("the seeded OpenRouter rows state their vocabularies ('none' listed on one, high|max on the other)", openrouter.openrouterEffortVocabularyFor('openrouter/stealth/ox-alpha').includes('none') && openrouter.openrouterEffortVocabularyFor('openrouter/stealth/ox-tall').join(',') === 'high,max')
  const SEEDED: Array<{ family: string; model: string; captured: () => Array<{ lane: string; body: unknown }>; lane: string; word: string; key: 'reasoning_effort' | 'reasoning' }> = [
    { family: 'gemini', model: 'gemini-fixture-pro', captured: () => census.captured, lane: 'gemini', word: 'low', key: 'reasoning_effort' },
    { family: 'openrouter', model: 'openrouter/stealth/ox-alpha', captured: () => shared.captured, lane: 'openrouter-seat', word: 'none', key: 'reasoning' },
    { family: 'openrouter', model: 'openrouter/stealth/ox-tall', captured: () => shared.captured, lane: 'openrouter-seat', word: 'high', key: 'reasoning' },
  ]
  for (const leg of SEEDED) {
    console.log(`\n  · ${leg.family} — ${leg.model} (session effort xhigh; the fold's thinking off)`)
    const before = leg.captured().length
    const run = await runFold(leg.model, 'direct')
    const hits = leg.captured().slice(before).filter(h => h.lane === leg.lane)
    check(`${leg.family}: the fold resolved on its own lane (${run.ms} ms)`, run.result !== undefined && run.error === undefined && hits.length >= 1, (run.error?.message ?? '').slice(0, 300))
    const body = (hits.at(-1)?.body ?? {}) as Record<string, unknown>
    const sent = leg.key === 'reasoning' ? ((body.reasoning as { effort?: unknown } | undefined)?.effort) : body.reasoning_effort
    check(`${leg.family}: the fold's wire carries the family's thinking-off word '${leg.word}' — ${leg.word === 'none' ? "the row lists none" : 'the lowest rung the row serves'} — never the session tier, never silence`, sent === leg.word, j({ sent, effort: effortWordsOf(body) }))
    check(`${leg.family}: no other effort spelling rides beside it`, effortWordsOf(body).length === 1 && effortWordsOf(body)[0] === leg.word, j(effortWordsOf(body)))
  }
}

section("§3 the stranger's road — a gateway carries it on the Anthropic dialect; the first-party origin refuses typed before any request")
{
  const stranger = 'totally-unknown-model-id'
  const before = shared.captured.length
  const gateway = await runFold(stranger, 'fork')
  const hits = shared.captured.slice(before)
  check(`gateway (the fixture base URL): the stranger's fold resolved on the fork road (${gateway.ms} ms)`, gateway.result !== undefined && gateway.error === undefined, (gateway.error?.message ?? '').slice(0, 300))
  check('gateway: every hit rode the Anthropic dialect (/v1/messages) — the endpoint owns its ids', hits.length >= 1 && hits.every(h => h.lane === 'anthropic-seat' && h.path === '/v1/messages'), hits.map(h => `${h.lane} ${h.path}`).join(' | '))
  check('gateway: the wire model is the stranger\'s own id, never a first-party spelling', hits.every(h => h.model === stranger), hits.map(h => h.model).join(','))
  check('gateway: the summary was installed (the read state cleared)', gateway.readFileState.size === 0)

  const savedBase = process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  const beforeAll = shared.captured.length + census.captured.length
  const home = await runFold(stranger, 'fork')
  const hitsAfter = shared.captured.length + census.captured.length - beforeAll
  process.env.ANTHROPIC_BASE_URL = savedBase
  const message = home.error?.message ?? ''
  check('first-party origin: the stranger\'s fold REFUSED (no result)', home.result === undefined && home.error !== undefined)
  check('first-party origin: no request reached any lane (refused before HTTP)', hitsAfter === 0, String(hitsAfter))
  check('first-party origin: the refusal names the id and says no family declares it', message.includes(stranger) && /not a model id any provider family declares/.test(message), message.slice(0, 300))
  check('first-party origin: the refusal names the declared vocabulary and both earned roads (a model pin, a gateway base URL)', /claude-\*/.test(message) && /ANTHROPIC_\* model pin/.test(message) && /ANTHROPIC_BASE_URL/.test(message), message.slice(0, 400))
  check('first-party origin: the conversation stands untouched (read state intact)', home.readFileState.size === 1, String(home.readFileState.size))

  const beforeAbsence = shared.captured.length + census.captured.length
  const absence = await runFold('', 'direct')
  const absenceHits = shared.captured.length + census.captured.length - beforeAbsence
  const absenceMessage = absence.error?.message ?? ''
  check('absence (no id): the fold REFUSED typed — no lane, no request', absence.result === undefined && absenceHits === 0 && /no model id rides this call/.test(absenceMessage), absenceMessage.slice(0, 300))
  check('absence: the conversation stands untouched', absence.readFileState.size === 1)
}

section('§4 the threshold is the SERVED window — the GPT ceiling and the [served] default, and the long-context cliff')
{
  const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
  const { gptPriceTierFor } = await import('../../src/services/providers/openai/gptPins.ts')
  const autoCompact = await import('../../src/services/compact/autoCompact.ts')
  const { contextFillView } = await import('../../src/utils/contextFill.ts')
  const tokens = await import('../../src/utils/tokens.ts')
  const jsonFetch = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', {
    force: true,
    fetchImpl: jsonFetch({
      models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'medium', context_window: 272_000, max_context_window: 872_000, supported_in_api: true },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'high', context_window: 272_000, max_context_window: 272_000, supported_in_api: true },
      ],
    }),
  })
  const bare = resolveContextWindow('gpt-6-astra')
  const served = resolveContextWindow('gpt-6-astra[served]')
  check('the bare id budgets the served CEILING (872,000; source live-current; default 272,000 recorded beside it)', bare.effectiveWindow === 872_000 && bare.source === 'live-current' && bare.catalogueCurrent === 272_000 && bare.catalogueMaximum === 872_000, j(bare))
  check('the [served] opt-down budgets the served DEFAULT (272,000)', served.effectiveWindow === 272_000 && served.source === 'live-current', j(served))
  const bareThreshold = autoCompact.getAutoCompactThreshold('gpt-6-astra')
  const servedThreshold = autoCompact.getAutoCompactThreshold('gpt-6-astra[served]')
  check('the bare id folds at the ceiling\'s usable edge: 872,000 − 20,000 (the summary reserve) − 3,000 (the manual headroom) = 849,000', bareThreshold === 849_000, String(bareThreshold))
  check('the [served] id folds at the default\'s usable edge: 272,000 − 23,000 = 249,000', servedThreshold === 249_000, String(servedThreshold))
  check('the gauge reads the same window the threshold reads (872,000 bare · 272,000 served)', contextFillView([] as never, 'gpt-6-astra').window === 872_000 && contextFillView([] as never, 'gpt-6-astra[served]').window === 272_000)

  let n = 0
  const transcriptAt = (total: number): unknown[] => {
    const output = 500
    const cacheRead = Math.floor(total / 3)
    const cacheCreation = 100
    const input = total - output - cacheRead - cacheCreation
    const usage = { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead }
    return [
      { type: 'user', uuid: `u-${++n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', uuid: `a-${++n}`, timestamp: new Date().toISOString(), message: { id: 'resp-X', model: 'gpt-6-astra', role: 'assistant', content: [{ type: 'text', text: 'block' }], usage, stop_reason: 'end_turn' } },
    ]
  }
  check('the count reads the settled usage exactly', tokens.tokenCountWithEstimation(transcriptAt(849_000) as never) === 849_000)
  const fireAt = await autoCompact.shouldAutoCompact(transcriptAt(849_000) as never, 'gpt-6-astra')
  const fireBelow = await autoCompact.shouldAutoCompact(transcriptAt(848_999) as never, 'gpt-6-astra')
  const fireAtCliff = await autoCompact.shouldAutoCompact(transcriptAt(272_001) as never, 'gpt-6-astra')
  const fireServed = await autoCompact.shouldAutoCompact(transcriptAt(249_000) as never, 'gpt-6-astra[served]')
  check('the bare id: false one token under 849,000, true at 849,000', fireBelow === false && fireAt === true, j({ fireBelow, fireAt }))
  check('the bare id crosses the 272,000 price cliff WITHOUT a fold (the threshold is the ceiling\'s, by the current law)', fireAtCliff === false)
  check('the [served] id folds at 249,000 — under the cliff', fireServed === true)

  const pin = catalogue.gptDisplayPin('gpt-6-astra')
  const base = pin ? gptPriceTierFor(pin, 272_000) : undefined
  const tier = pin ? gptPriceTierFor(pin, 272_001) : undefined
  check('the long-context tier bites past 272,000 input tokens: 2× input and cache, 1.5× output', base?.costInPerMtok === 10 && base?.cachedInPerMtok === 1 && base?.costOutPerMtok === 50 && tier?.costInPerMtok === 20 && tier?.cachedInPerMtok === 2 && tier?.costOutPerMtok === 75, j({ base, tier }))
  if (base && tier) {
    const usd = (v: number): string => `$${v.toFixed(3)}`
    const perTurn = (prompt: number, rates: typeof base, newTokens: number, out: number): number =>
      ((prompt - newTokens) * (rates.cachedInPerMtok ?? 0) + newTokens * (rates.costInPerMtok ?? 0) + out * (rates.costOutPerMtok ?? 0)) / 1_000_000
    console.log('\n  the cliff, at list price (a warm turn: the prefix cached, 5,000 new input tokens, 1,000 output tokens):')
    console.log(`    at 249,000 tokens (the [served] fold point)     ${usd(perTurn(249_000, base, 5_000, 1_000))} per turn`)
    console.log(`    at 272,000 tokens (the last short-context turn)  ${usd(perTurn(272_000, base, 5_000, 1_000))} per turn`)
    console.log(`    at 272,001 tokens (the first long-context turn)  ${usd(perTurn(272_001, tier, 5_000, 1_000))} per turn`)
    console.log(`    at 500,000 tokens                                ${usd(perTurn(500_000, tier, 5_000, 1_000))} per turn`)
    console.log(`    at 849,000 tokens (the bare fold point)          ${usd(perTurn(849_000, tier, 5_000, 1_000))} per turn`)
    console.log(`    a cold 300,000-token request                     ${usd((300_000 * (tier.costInPerMtok ?? 0)) / 1_000_000)} vs ${usd((300_000 * (base.costInPerMtok ?? 0)) / 1_000_000)} under the base tier`)
  }
}

section('§5 the OpenAI road across a fold — the kept tail replays its reasoning items; the folded head\'s never ride')
{
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
  const record = (k: string, items: unknown[]): Record<string, unknown> => ({
    apexProviderTurn: { provider: 'openai', responseId: `resp_${k}`, items, contractDigest: 'fixture' },
  })
  const reasoning = (k: string): unknown => ({ type: 'reasoning', id: `rs_${k}`, summary: [], encrypted_content: `enc-${k}` })
  const messageItem = (text: string): unknown => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  const gptRow = (k: string, text: string, extraBlocks: unknown[] = [], items?: unknown[]): unknown => {
    const row = assistantRow(text, record(k, items ?? [reasoning(k), messageItem(text)]), 'gpt-5.5') as { message: { content: unknown[] } }
    row.message.content = [{ type: 'thinking', thinking: `summary ${k}`, signature: '' }, ...extraBlocks, { type: 'text', text }]
    return row
  }
  const messages: unknown[] = []
  for (let i = 1; i <= 9; i++) {
    messages.push(createUserMessage({ content: `step ${i}: work the item` }))
    if (i === 8) {
      const toolRow = assistantRow('', record('8', [reasoning('8'), { type: 'function_call', call_id: 'toolu_8', name: 'Read', arguments: '{"file_path":"/tmp/x.ts"}' }]), 'gpt-5.5') as { message: { content: unknown[]; stop_reason: string } }
      toolRow.message.content = [{ type: 'thinking', thinking: 'summary 8', signature: '' }, { type: 'tool_use', id: 'toolu_8', name: 'Read', input: { file_path: '/tmp/x.ts' } }]
      toolRow.message.stop_reason = 'tool_use'
      messages.push(toolRow)
      messages.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_8', content: 'export const x = 1' }] }))
      messages.push(gptRow('8b', 'read the file'))
      continue
    }
    messages.push(gptRow(String(i), `done with step ${i}`))
  }
  const before = shared.captured.length
  const run = await runFold('gpt-5.5', 'direct', messages)
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  const foldHits = shared.captured.slice(before).filter(h => h.lane === 'openai-seat')
  check(`the fold resolved on the OpenAI direct road (${run.ms} ms)`, run.result !== undefined && run.error === undefined && foldHits.length >= 1, (run.error?.message ?? '').slice(0, 300))
  const kept = (run.result?.messagesToKeep ?? []) as Array<{ type: string; message: { content: unknown[] }; apexProviderTurn?: unknown }>
  const keptAssistants = kept.filter(m => m.type === 'assistant')
  check('a verbatim tail was kept (whole rounds; assistant rows present)', kept.length > 0 && keptAssistants.length >= 3, `kept ${kept.length} rows, ${keptAssistants.length} assistant`)
  check('the kept tail carries no thinking block (the strip is family-neutral)', keptAssistants.every(m => m.message.content.every(b => (b as { type?: string }).type !== 'thinking')))
  check('every kept assistant row still carries its replay record (the strip touches content only)', keptAssistants.every(m => m.apexProviderTurn !== undefined))
  check('the kept tool round survives whole (tool_use and its result)', kept.some(m => m.type === 'assistant' && m.message.content.some(b => (b as { type?: string }).type === 'tool_use')) && kept.some(m => m.type === 'user' && j(m.message.content).includes('toolu_8')))
  const keptIds = keptAssistants.map(m => ((m.apexProviderTurn as { responseId?: string })?.responseId ?? '').replace('resp_', ''))

  if (run.result !== undefined) {
    const post = [...buildPostCompactMessages(run.result as never), createUserMessage({ content: 'continue with the next step' })]
    const api = normalizeMessagesForAPI(post as never, [])
    const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
    const settled: Array<{ message: { content: unknown[] } }> = []
    const beforeNext = shared.captured.length
    let nextError: string | undefined
    try {
      const stream = routedCallModel({
        messages: api,
        systemPrompt: asSystemPrompt([`You are a ${POSTURE_MARK}.`]),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          getToolPermissionContext: () => Promise.resolve(toolPermissionContext),
          model: 'gpt-5.5',
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          querySource: 'sdk',
          agents: [],
          mcpTools: [],
          ownerKey: 'fold-roads-post',
        },
      } as never)
      for await (const event of stream) {
        if ((event as { type?: string }).type === 'assistant') settled.push(event as never)
      }
    } catch (err) {
      nextError = err instanceof Error ? err.message : String(err)
    }
    const next = shared.captured.slice(beforeNext).filter(h => h.lane === 'openai-seat').at(-1)
    const input = ((next?.body as { input?: unknown[] } | undefined)?.input ?? []) as Array<{ type?: string; id?: string; encrypted_content?: string; call_id?: string; role?: string }>
    const reasoningItems = input.filter(i => i.type === 'reasoning')
    const wireIds = reasoningItems.map(i => (i.id ?? '').replace('rs_', ''))
    check('the first post-fold request reached the OpenAI wire', next !== undefined && nextError === undefined, nextError ?? 'no hit')
    check(`the kept turns' reasoning items replay, in order, with their encrypted content (${j(wireIds)})`, wireIds.length === keptIds.length && wireIds.every((id, index) => id === keptIds[index]) && reasoningItems.every(i => typeof i.encrypted_content === 'string' && i.encrypted_content === `enc-${(i.id ?? '').replace('rs_', '')}`), `kept ${j(keptIds)} · wire ${j(wireIds)}`)
    check('no folded turn\'s reasoning rides (the summary stands for the head)', wireIds.every(id => keptIds.includes(id)) && !wireIds.some(id => ['1', '2', '3'].includes(id)))
    const callIndex = input.findIndex(i => i.type === 'function_call' && i.call_id === 'toolu_8')
    check('the kept tool call replays behind its own reasoning item (the pairing law)', callIndex > 0 && input[callIndex - 1]?.type === 'reasoning' && input[callIndex - 1]?.id === 'rs_8' && input.some(i => i.type === 'function_call_output' && i.call_id === 'toolu_8'), j(input.map(i => `${i.type}${i.id ? `:${i.id}` : ''}${i.call_id ? `:${i.call_id}` : ''}`)))
    const notes = settled.flatMap(m => m.message.content).filter(b => (b as { type?: string }).type === 'text').map(b => (b as { text?: string }).text ?? '')
    check('no reconstruction receipt paints (the records rode; nothing predates capture)', notes.every(t => !t.includes('reconstructed continuation')), notes.join(' | ').slice(0, 200))
  }
}

section('§6 the fold bounds, measured — a cut stream is never a summary (the fork hands over; the direct lane refuses typed)')
{
  type Paced = { n: number; bytes: number; startedAt: number; endedAt?: number; cutAfterMs?: number; complete: boolean; chunksSent: number }
  const paced: Paced[] = []
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
  const CHUNKS = ['paced ', 'summary ', 'body: ', 'the ', 'stream ', 'is ', 'healthy ', 'but ', 'longer ', 'than ', 'the ', 'stall.']
  const PACE_MS = 200
  const STALL_MS = 600
  let plan: 'healthy' | 'wedge' = 'healthy'
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const entry: Paced = { n: paced.length + 1, bytes: Buffer.concat(chunks).length, startedAt: Date.now(), complete: false, chunksSent: 0 }
      paced.push(entry)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_paced', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`)
      res.write(`event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`)
      const timers: NodeJS.Timeout[] = []
      res.on('close', () => {
        if (!entry.complete) {
          entry.cutAfterMs = Date.now() - entry.startedAt
          for (const t of timers) clearTimeout(t)
        }
      })
      const tick = (): void => {
        if (res.destroyed) return
        if (plan === 'wedge' && entry.chunksSent === 3) return
        if (entry.chunksSent < CHUNKS.length) {
          res.write(`event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CHUNKS[entry.chunksSent] } })}`)
          entry.chunksSent++
          timers.push(setTimeout(tick, PACE_MS))
          return
        }
        res.write(`event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`)
        res.write(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 } })}`)
        res.write(`event: message_stop\n${sse({ type: 'message_stop' })}`)
        entry.complete = true
        entry.endedAt = Date.now()
        res.end()
      }
      timers.push(setTimeout(tick, PACE_MS))
    })
  })
  await new Promise<void>(resolve => server.listen(PACED_PORT, '127.0.0.1', resolve))
  const savedBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PACED_PORT}`
  setFoldBoundsForTests({ deadlineMs: 60_000, stallMs: STALL_MS })
  const healthyMs = CHUNKS.length * PACE_MS
  type FoldRow = { kind: string; road?: string; outcome?: string; detail?: string; ms?: number }
  const foldRowsNow = (): FoldRow[] => {
    const files = readdirSync(DUMP_DIR).filter(f => f.endsWith('.jsonl'))
    if (files.length !== 1) return []
    return readFileSync(join(DUMP_DIR, files[0]!), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as FoldRow).filter(r => r.kind === 'fold')
  }

  console.log('\n  · leg A — the fork road on a healthy stream longer than the stall watchdog')
  plan = 'healthy'
  const rowsBeforeA = foldRowsNow().length
  const run = await runFold('claude-opus-4-8', 'fork')
  const legA = paced.splice(0)
  const rowsA = foldRowsNow().slice(rowsBeforeA)
  const summary = j(run.result?.summaryMessages ?? [])
  check(`the fold LANDED (${run.ms} ms, ${legA.length} request(s))`, run.result !== undefined && run.error === undefined, (run.error?.message ?? '').slice(0, 300))
  check('the installed summary is the WHOLE stream — a cut stream is never a summary', summary.includes('paced summary body: the stream is healthy but longer than the stall.'), summary.slice(0, 300))
  check('one or two requests: the fork alone, or the fork then the direct lane', legA.length === 1 || legA.length === 2, String(legA.length))
  if (legA.length === 2) {
    const [fork, direct] = legA as [Paced, Paced]
    const forkRow = rowsA.find(r => r.road === 'fork' && r.outcome === 'handover')
    const cutMs = Number(/fold bound after (\d+) ms/.exec(forkRow?.detail ?? '')?.[1] ?? NaN)
    check(`the fork was cut at the stall while streaming healthily (the fold row: cut after ${cutMs} ms of a ${healthyMs} ms stream; watchdog ${STALL_MS} ms) and its partial output was discarded`, forkRow !== undefined && cutMs >= STALL_MS && cutMs < healthyMs, j(rowsA))
    check(`the direct lane completed the same stream (touched per event; ${direct.endedAt !== undefined ? direct.endedAt - direct.startedAt : -1} ms) and wrote a summary row`, direct.complete === true && rowsA.some(r => r.road === 'direct' && r.outcome === 'summary'), j(rowsA))
    console.log(`  MEASURED: fork cut after ${cutMs} ms (a healthy ${healthyMs} ms stream; ${fork.bytes} request bytes wasted — the server went on writing to the dead reader); direct lane landed after ${direct.endedAt !== undefined ? direct.endedAt - direct.startedAt : -1} ms; whole fold ${run.ms} ms`)
  } else if (legA.length === 1) {
    const [only] = legA as [Paced]
    check(`the fork completed its healthy stream without a hand-over (${only.endedAt !== undefined ? only.endedAt - only.startedAt : -1} ms)`, only.complete === true && rowsA.some(r => r.road === 'fork' && r.outcome === 'summary'), j(rowsA))
    console.log(`  MEASURED: no hand-over — the fork streamed ${healthyMs} ms under a ${STALL_MS} ms watchdog; whole fold ${run.ms} ms`)
  }

  console.log('\n  · leg B — the direct road on a wire that wedges mid-stream')
  plan = 'wedge'
  const rowsBeforeB = foldRowsNow().length
  const wedged = await runFold('claude-opus-4-8', 'direct')
  const legB = paced.splice(0)
  const rowsB = foldRowsNow().slice(rowsBeforeB)
  const timeoutRow = rowsB.find(r => r.road === 'direct' && r.outcome === 'timeout')
  check('the wedged fold REFUSED (no result)', wedged.result === undefined && wedged.error !== undefined)
  check('the refusal is the typed fold-timeout sentence — never the three received chunks as a summary', wedged.error?.message === compactModule.ERROR_MESSAGE_FOLD_TIMEOUT, (wedged.error?.message ?? '').slice(0, 300))
  check('the conversation stands untouched (read state intact)', wedged.readFileState.size === 1, String(wedged.readFileState.size))
  check('the wire saw one direct request: three chunks were written, then silence, and the stream never completed', legB.length === 1 && legB[0]!.complete === false && legB[0]!.chunksSent === 3, j(legB))
  check(`the direct road's timeout row carries the stall's wall time (≥ ${STALL_MS} ms)`, timeoutRow !== undefined && (timeoutRow.ms ?? 0) >= STALL_MS, j(rowsB))
  console.log(`  MEASURED: direct lane cut after ${timeoutRow?.ms ?? -1} ms (3 chunks at ${PACE_MS} ms, then ${STALL_MS} ms of silence); whole fold ${wedged.ms} ms`)

  setFoldBoundsForTests(null)
  process.env.ANTHROPIC_BASE_URL = savedBase
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

section('§7 the wire dump — every road writes its fold row beside the request rows; the replay tool skips them')
{
  const { readCapture, messageRows } = await import('../api/wire-prefix-replay.ts')
  const files = readdirSync(DUMP_DIR).filter(f => f.endsWith('.jsonl'))
  check('one dump file for this process', files.length === 1, j(files))
  type Row = { kind: string; family?: string; road?: string; model?: string; outcome?: string; detail?: string; ms?: number; source?: string; url?: string; body?: unknown }
  const rows: Row[] = files.length === 1 ? readFileSync(join(DUMP_DIR, files[0]!), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Row) : []
  const folds = rows.filter(r => r.kind === 'fold')
  const requests = rows.filter(r => r.kind === 'request')
  const has = (family: string, road: string, outcome: string, detail?: RegExp): boolean =>
    folds.some(r => r.family === family && r.road === road && r.outcome === outcome && (detail === undefined || detail.test(r.detail ?? '')))
  for (const family of ['openai', 'zai', 'openrouter', 'moonshot', 'deepseek', 'gemini', 'huggingface', 'openai-compat', 'local']) {
    check(`${family}: a direct-road fold row with a summary outcome`, has(family, 'direct', 'summary'))
  }
  check('anthropic: the fork road landed the summary (the full parent context)', has('anthropic', 'fork', 'summary'))
  check('anthropic: the posture-only fold reads fork:handover then direct:summary (two roads, never one family twice)', has('anthropic', 'fork', 'handover') && has('anthropic', 'direct', 'summary'))
  check('the stranger on the gateway: an unrecognised fork row with a summary', has('unrecognised', 'fork', 'summary'))
  check('the stranger on the first-party origin: fork:handover then direct:refused', has('unrecognised', 'fork', 'handover', /no usable summary/) && has('unrecognised', 'direct', 'refused'))
  check('absence: a direct:refused row', has('absence', 'direct', 'refused'))
  const boundRow = folds.find(r => r.family === 'anthropic' && r.road === 'fork' && r.outcome === 'handover' && /fold bound after \d+ ms/.test(r.detail ?? ''))
  note(boundRow ? `the stall hand-over row: ${j(boundRow)}` : 'no stall hand-over row (the fork completed its healthy stream)')
  check('the wedged direct lane wrote a direct:timeout row', has('anthropic', 'direct', 'timeout'))
  check('every fold row carries the family, the road, the model and a wall time', folds.every(r => typeof r.family === 'string' && (r.road === 'fork' || r.road === 'direct') && typeof r.model === 'string' && typeof r.ms === 'number'))
  const anthropicRequests = requests.filter(r => (r.url ?? '').includes('/messages'))
  const openaiRequests = requests.filter(r => (r.url ?? '').endsWith('/responses'))
  check('the Anthropic request rows carry the fold\'s query source (compact)', anthropicRequests.length >= 1 && anthropicRequests.every(r => r.source === 'compact'), j([...new Set(anthropicRequests.map(r => r.source))]))
  check('the OpenAI request rows are on the dump too (the lane\'s own source word)', openaiRequests.length >= 1 && openaiRequests.every(r => r.source === 'openai'), j([...new Set(openaiRequests.map(r => r.source))]))
  note(`request rows: ${anthropicRequests.length} Anthropic · ${openaiRequests.length} OpenAI · ${requests.length - anthropicRequests.length - openaiRequests.length} other — the chat-completions lanes carry no wrapped fetch (the instrument's reach today), so their folds are known by their fold rows alone`)
  check('the replay tool reads the request rows and skips the fold rows', messageRows(readCapture(join(DUMP_DIR, files[0] ?? ''))).length === requests.length, `${messageRows(readCapture(join(DUMP_DIR, files[0] ?? ''))).length} vs ${requests.length}`)
}

section('§9 the home direct lane under thinking disabled: replayed signed thinking never rides the wire')
{
  const model = 'claude-opus-4-8'
  const history = makeMessages() as Array<{ type?: string; message?: { content?: unknown[] } }>
  const row = history[1]!
  row.message!.content = [{ type: 'thinking', thinking: 'earlier reasoning, signed', signature: 'sig-earlier' }, ...(row.message!.content as unknown[])]
  const foldFrom = shared.captured.length
  const run = await runFold(model, 'direct', history as never)
  const foldHits = shared.captured.slice(foldFrom).filter(h => h.lane === 'anthropic-seat')
  check('§9: the fold resolved on the home direct road', run.error === undefined && foldHits.length >= 1, (run.error?.message ?? '').slice(0, 200))
  const body = (foldHits[foldHits.length - 1]?.body ?? {}) as { thinking?: { type?: string }; messages?: Array<{ role?: string; content?: unknown }> }
  const thinkingBlocks = (body.messages ?? []).flatMap(m => (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>).filter(b => b.type === 'thinking' || b.type === 'redacted_thinking') : []))
  check("§9: the request declares no thinking and carries NO thinking block (the strip is the one owner for every road)", (body.thinking === undefined || body.thinking.type === 'disabled') && thinkingBlocks.length === 0, `${thinkingBlocks.length} thinking block(s); thinking=${JSON.stringify(body.thinking)}`)
  check("§9: the history's own text still rides", (body.messages ?? []).some(m => JSON.stringify(m.content).includes('Bumped the version')))
}

await shared.close()
await census.close()
clearTimeout(guard)

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ FOLD FAMILY ROADS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} FOLD FAMILY ROADS FAILURE(S)`)
process.exit(1)
