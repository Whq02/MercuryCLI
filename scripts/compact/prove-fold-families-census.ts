#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(MODEL|SMALL_FAST_MODEL|AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_OAUTH_TOKEN|MERCURY_SCRIPTED_STREAM|MERCURY_BARE|MERCURY_MAX_OUTPUT_TOKENS|MERCURY_HOME|MERCURY_EFFORT_LEVEL|MERCURY_THINKING_BUDGET)$/.test(key) ||
    /^(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|HF)_/.test(key) ||
    /^HF_TOKEN$/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|OPENROUTER|HUGGINGFACE|COMPAT|LOCAL)_/.test(key)
  ) {
    delete process.env[key]
  }
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-census-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const CENSUS_PORT = 34121
const SHARED_PORT = 34123

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
  console.log('\nTIMEOUT — fold families census exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compactConversation } = await import('../../src/services/compact/compact.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

function makeMessages(): unknown[] {
  return [
    createUserMessage({ content: 'please bump the version and run the tests' }),
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-a000-0000000000f1',
      requestId: 'req_c1',
      message: {
        id: 'msg_c1',
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: 'Bumped the version and ran the suite — all green.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
    createUserMessage({ content: 'now write the changelog entry' }),
  ]
}

type Run = { result?: Record<string, unknown>; error?: Error; readFileStateSize: number }

async function runFold(model: string): Promise<Run> {
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
  readFileState.set('/tmp/census-file.ts', { content: 'export const x = 1\n', timestamp: Date.now(), offset: undefined, limit: undefined })
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    readFileState,
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: model,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(
      makeMessages() as never,
      ctx as never,
      { systemPrompt: asSystemPrompt(['census session posture']) } as never,
      true,
    )) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  return { result, error, readFileStateSize: readFileState.size }
}

section('§1 KEYLESS — every credential family refuses TYPED with its own door')
const KEYLESS_LEGS: Array<{ family: string; model: string; needle: RegExp }> = [
  { family: 'moonshot', model: 'kimi-k2-0905-preview', needle: /\/logins moonshot|MOONSHOT_API_KEY/ },
  { family: 'deepseek', model: 'deepseek-chat', needle: /\/logins deepseek|DEEPSEEK_API_KEY/ },
  { family: 'gemini', model: 'gemini-2.5-pro', needle: /Gemini/ },
  { family: 'huggingface', model: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', needle: /HF_TOKEN|Hugging Face/ },
  { family: 'openrouter', model: 'openrouter/nvidia/nemotron-nano-9b-v2:free', needle: /OPENROUTER_API_KEY|OpenRouter/ },
  { family: 'openai', model: 'gpt-5.5', needle: /OpenAI/ },
  { family: 'zai', model: 'glm-5.2', needle: /ZAI_API_KEY|Z\.AI/ },
  { family: 'openai-compat', model: 'compat/census-endpoint-model', needle: /MERCURY_COMPAT_BASE_URL/ },
  { family: 'local', model: 'local/census-local-model', needle: /local server|MERCURY_LOCAL_BASE_URL/ },
]
for (const leg of KEYLESS_LEGS) {
  const run = await runFold(leg.model)
  const message = run.error?.message ?? ''
  check(`${leg.family}: the keyless fold REFUSES (no result)`, run.result === undefined && run.error !== undefined)
  check(`${leg.family}: the refusal names the family's own door`, leg.needle.test(message), message.slice(0, 180))
  check(`${leg.family}: the conversation stands untouched`, run.readFileStateSize === 1, `readFileState.size=${run.readFileStateSize}`)
}
note('anthropic (home): keyless is NOT asserted — the home credential resolution reaches outside the env (stored sign-ins), so the leg would pin the box, not the law; the credentialed leg below covers the family.')

section('§2 CREDENTIALED — all ten families fold on their own wire')
const { startFoldFamiliesFixture } = await import('./foldFamiliesFixture.ts')
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const census = await startFoldFamiliesFixture({ port: CENSUS_PORT })
const shared = await startCrossfamilyFixture({ port: SHARED_PORT })
Object.assign(process.env, census.env, shared.env)
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
await refreshLocalDiscovery({ force: true })

const SESSION_TIERS = new Set(['xhigh', 'x-high', 'high', 'medium', 'max'])
function effortWordsOf(body: unknown): string[] {
  const words: string[] = []
  const record = body as { reasoning_effort?: unknown; reasoning?: { effort?: unknown }; output_config?: { effort?: unknown } }
  if (typeof record.reasoning_effort === 'string') words.push(record.reasoning_effort)
  if (record.reasoning && typeof (record.reasoning as { effort?: unknown }).effort === 'string') words.push((record.reasoning as { effort: string }).effort)
  if (record.output_config && typeof record.output_config.effort === 'string') words.push(record.output_config.effort)
  return words
}

const CENSUS_LEGS: Array<{ family: string; model: string; lane: string }> = [
  { family: 'moonshot', model: 'kimi-k2-0905-preview', lane: 'moonshot' },
  { family: 'deepseek', model: 'deepseek-chat', lane: 'deepseek' },
  { family: 'gemini', model: 'gemini-2.5-pro', lane: 'gemini' },
  { family: 'huggingface', model: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', lane: 'huggingface' },
  { family: 'openai-compat', model: 'compat/census-endpoint-model', lane: 'openai-compat' },
  { family: 'local', model: 'local/census-local-model', lane: 'local' },
]
for (const leg of CENSUS_LEGS) {
  console.log(`\n  · ${leg.family} — ${leg.model}`)
  const before = census.captured.length
  const run = await runFold(leg.model)
  const hits = census.captured.slice(before).filter(h => h.path.endsWith('/chat/completions'))
  check(`${leg.family}: the fold resolves`, run.result !== undefined && run.error === undefined, (run.error?.message ?? '').slice(0, 200))
  check(`${leg.family}: the wire saw the fold on its own lane`, hits.length >= 1 && hits.every(h => h.lane === leg.lane), hits.map(h => `${h.lane} ${h.path}`).join(' | '))
  check(
    `${leg.family}: the summary was installed (the dialect's own answer)`,
    j(run.result?.summaryMessages ?? []).includes(`${leg.lane}-census body.`),
    j(run.result?.summaryMessages ?? []).slice(0, 160),
  )
  const words = hits.flatMap(h => effortWordsOf(h.body))
  check(
    `${leg.family}: mechanical effort on the wire (never the session tier)`,
    words.every(word => !SESSION_TIERS.has(word.toLowerCase())),
    j(words),
  )
  check(`${leg.family}: the read state cleared (the fold landed)`, run.readFileStateSize === 0, `size=${run.readFileStateSize}`)
}

const SHARED_LEGS: Array<{ family: string; model: string; lane: string }> = [
  { family: 'anthropic', model: 'claude-opus-4-8', lane: 'anthropic-seat' },
  { family: 'openai', model: 'gpt-5.5', lane: 'openai-seat' },
  { family: 'zai', model: 'glm-5.2', lane: 'zai-seat' },
  { family: 'openrouter', model: 'openrouter/nvidia/nemotron-nano-9b-v2:free', lane: 'openrouter-seat' },
]
for (const leg of SHARED_LEGS) {
  console.log(`\n  · ${leg.family} — ${leg.model}`)
  const before = shared.captured.length
  const run = await runFold(leg.model)
  const hits = shared.captured.slice(before)
  check(`${leg.family}: the fold resolves`, run.result !== undefined && run.error === undefined, (run.error?.message ?? '').slice(0, 200))
  check(`${leg.family}: the wire saw the fold on its own lane`, hits.length >= 1 && hits.every(h => h.lane === leg.lane), hits.map(h => h.lane).join(', '))
  check(`${leg.family}: the read state cleared (the fold landed)`, run.readFileStateSize === 0, `size=${run.readFileStateSize}`)
}

check('the census fixture saw no stray lane', census.captured.every(h => h.lane !== 'other'), j(census.captured.filter(h => h.lane === 'other').map(h => h.path)))

section('§3 the roster latch — every lane plans its tools under the one owner key')
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ROOT = join(import.meta.dir, '..', '..')
  const LANES = [
    'src/services/providers/anthropic/streamCore.ts',
    'src/services/providers/openai/openaiCallModel.ts',
    'src/services/providers/zai/zaiCallModel.ts',
    'src/services/providers/openaicompat/compatChatCallModel.ts',
  ]
  const LATCH = /planToolPayload\(\{[\s\S]{0,900}?latchKey: (?:rosterOwnerKey|options\.ownerKey \?\? String\(processOwnerForLane\(options\.agentId \?\? null\)\))/
  for (const lane of LANES) {
    const text = readFileSync(join(ROOT, lane), 'utf8')
    const plans = text.split('planToolPayload({').length - 1
    check(`${lane.split('/').slice(-1)[0]}: its tool plan carries the owner's latch key`, plans >= 1 && LATCH.test(text), `${plans} plan(s)`)
  }
}

await census.close()
await shared.close()
clearTimeout(guard)

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ FOLD FAMILIES CENSUS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} FOLD FAMILIES CENSUS FAILURE(S)`)
process.exit(1)
