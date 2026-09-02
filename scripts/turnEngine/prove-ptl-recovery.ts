#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ptl-laws-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE
delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
delete process.env.DISABLE_AUTO_COMPACT
delete process.env.DISABLE_COMPACT
delete process.env.MERCURY_CTX_COMPACTION

import { z } from 'zod/v4'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'ptl-laws-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { query } = await import('../../src/query.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import(
  '../../src/utils/fileStateCache.ts'
)
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — PTL recovery proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const COMPACT_NEEDLE = 'running record of this conversation'
const isCompactRequest = (r: { raw: string }): boolean => r.raw.includes(COMPACT_NEEDLE)


function makeAssistant(seq: number, text: string, inputTokens: number): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-a000-0000000ptl${String(seq).padStart(2, '0')}`.slice(0, 36),
    requestId: `req_ptl_${seq}`,
    message: {
      id: `msg_ptl_${seq}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 400 },
    },
  }
}

function makeHistory(contextTokens: number): Array<Record<string, unknown>> {
  return [
    createUserMessage({ content: 'PTL HISTORY NEEDLE alpha — please refactor the tokenizer.' }) as never,
    makeAssistant(1, 'Refactored the tokenizer into three passes; the lexer table is now data-driven.', Math.floor(contextTokens / 2)),
    createUserMessage({ content: 'PTL HISTORY NEEDLE beta — now run the whole test suite.' }) as never,
    makeAssistant(2, 'Suite ran green: 412 tests, 0 failures. The slowest file is the parser corpus.', contextTokens),
    createUserMessage({ content: 'Continue with the follow-up work.' }) as never,
  ]
}

function makeFakeTool(): Record<string, unknown> {
  return {
    name: 'PtlProbeTool',
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    interruptBehavior: () => 'cancel' as const,
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: {} }),
    description: async () => 'ptl probe tool',
    prompt: async () => 'ptl probe tool prompt',
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: async () => ({ data: 'ptl probe tool ran' }),
  }
}

type Collected = {
  messages: Array<Record<string, unknown>>
  terminal: { reason: string } | undefined
  api: FixtureApi
}

async function runQuery(opts: {
  turns: ScriptedTurn[]
  history: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  env?: Record<string, string>
}): Promise<Collected> {
  const envKeys = Object.keys(opts.env ?? {})
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v
  const api = await startFixtureApi(opts.turns)
  process.env.ANTHROPIC_BASE_URL = api.url

  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
  }
  const tools = opts.tools ?? []
  const toolUseContext: Record<string, unknown> = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (f: (p: Record<string, unknown>) => Record<string, unknown>) => {
      state = f(state)
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    toolDecisions: new Map(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    options: {
      commands: [],
      tools,
      mcpClients: [],
      mcpResources: {},
      mainLoopModel: 'claude-opus-4-8',
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      debug: false,
      verbose: false,
    },
  }

  const gen = query({
    messages: opts.history as never,
    systemPrompt: asSystemPrompt(['You are a PTL probe. Reply tersely.']),
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    toolUseContext: toolUseContext as never,
    querySource: 'sdk',
  } as never)

  const messages: Array<Record<string, unknown>> = []
  let terminal: { reason: string } | undefined
  try {
    for (;;) {
      const r = await gen.next()
      if (r.done) {
        terminal = r.value as { reason: string }
        break
      }
      messages.push(r.value as Record<string, unknown>)
    }
  } finally {
    await api.close()
    for (const k of envKeys) delete process.env[k]
  }
  return { messages, terminal, api }
}

console.log('============================================================')
console.log(' query()/queryLoop — the PTL single-shot recovery laws')
console.log('============================================================')

section('§0 — the reactiveCompact withheld-413 band is structurally ABSENT (deleted lane)')
{
  const readDir = (rel: string): string => {
    const dir = new URL(rel, import.meta.url)
    return readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(new URL(`${rel}${f}`, import.meta.url), 'utf8'))
      .join('\n')
  }
  const moduleSrc =
    readFileSync(new URL('../../src/query.ts', import.meta.url), 'utf8') +
    readDir('../../src/query/') +
    readDir('../../src/run-core/')
  check(
    'the query module carries NO reactiveCompact band (tryReactiveCompact / isWithheldPromptTooLong / hasAttemptedReactiveCompact)',
    !/tryReactiveCompact|isWithheldPromptTooLong|hasAttemptedReactiveCompact/.test(
      moduleSrc,
    ),
    'the reactive-compact lane came alive — its PTL single-shot band now needs BEHAVIORAL rows here',
  )
}

const GOOD_SUMMARY =
  'PTL RECOVERY SUMMARY needle: the session refactored the tokenizer into three data-driven passes and ran the 412-test suite green. ' +
  'Open work: the follow-up requested in the last user turn.'

section('§1 — over-threshold history: ONE compact round, the summary installs, the turn proceeds')
{
  const r = await runQuery({
    turns: [
      { kind: 'text', text: GOOD_SUMMARY },
      { kind: 'text', text: 'P1 MAIN TURN OVER THE COMPACTED VIEW.' },
    ],
    history: makeHistory(50_000),
    env: { MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '0.001' },
  })
  const reqs = r.api.messageRequests()
  check('exactly two model calls (compact + main)', reqs.length === 2, `${reqs.length}`)
  check('call 1 is the COMPACT request (carries the summary instruction)', !!reqs[0] && isCompactRequest(reqs[0]))
  check('the compact request carries the real history', !!reqs[0] && reqs[0].raw.includes('PTL HISTORY NEEDLE alpha'))
  check('call 2 is the MAIN request (no compact instruction)', !!reqs[1] && !isCompactRequest(reqs[1]))
  check('the main request rides the COMPACTED view (summary on the wire)', !!reqs[1] && reqs[1].raw.includes('PTL RECOVERY SUMMARY needle'))
  check('the compact summary message yields (isCompactSummary)', r.messages.some(m => (m as { isCompactSummary?: boolean }).isCompactSummary === true))
  check('the main-turn text yields', r.messages.some(m => m.type === 'assistant' && j(m).includes('P1 MAIN TURN')))
  check("Terminal reason 'completed'", r.terminal?.reason === 'completed', r.terminal?.reason)
}

section('§2 — a FAILED compact round (fork + fallback) does not kill the turn; no retry')
{
  const r = await runQuery({
    turns: [
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'ptl compact fixture refusal' },
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'ptl compact fixture refusal' },
      { kind: 'text', text: 'P2 MAIN TURN OVER THE ORIGINAL HISTORY.' },
    ],
    history: makeHistory(50_000),
    env: { MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '0.001' },
  })
  const reqs = r.api.messageRequests()
  check('exactly three model calls (fork compact + fallback compact + main)', reqs.length === 3, `${reqs.length}`)
  check('calls 1+2 are the ONE compact round (both lanes)', !!reqs[0] && !!reqs[1] && isCompactRequest(reqs[0]) && isCompactRequest(reqs[1]))
  check('call 3 is the MAIN request over the ORIGINAL history', !!reqs[2] && !isCompactRequest(reqs[2]) && reqs[2].raw.includes('PTL HISTORY NEEDLE alpha'))
  check('the main-turn text yields', r.messages.some(m => m.type === 'assistant' && j(m).includes('P2 MAIN TURN')))
  check("Terminal reason 'completed'", r.terminal?.reason === 'completed', r.terminal?.reason)
}

section("§3 — failed compact + blocked level: the preempt surfaces PTL, {reason:'blocking_limit'}, no main call")
{
  const r = await runQuery({
    turns: [
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'ptl compact fixture refusal' },
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'ptl compact fixture refusal' },
    ],
    history: makeHistory(50_000),
    env: {
      MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '0.001',
      MERCURY_BLOCKING_LIMIT_OVERRIDE: '10000',
    },
  })
  const reqs = r.api.messageRequests()
  check('exactly two model calls (the failed compact round only — the main call is never made)', reqs.length === 2, `${reqs.length}`)
  const ptlYield = r.messages.find(
    m => m.type === 'assistant' && (m as { isApiErrorMessage?: boolean }).isApiErrorMessage === true && j(m).includes(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
  check('the synthetic PTL assistant error yields', !!ptlYield, j(r.messages).slice(0, 300))
  check("Terminal reason 'blocking_limit'", r.terminal?.reason === 'blocking_limit', r.terminal?.reason)
}

section('§4 — autocompact disabled + blocked level: the preempt fires with ZERO API calls')
{
  const r = await runQuery({
    turns: [],
    history: makeHistory(50_000),
    env: {
      DISABLE_AUTO_COMPACT: '1',
      MERCURY_BLOCKING_LIMIT_OVERRIDE: '10000',
    },
  })
  const reqs = r.api.messageRequests()
  check('ZERO model calls — the preempt returns before the API', reqs.length === 0, `${reqs.length}`)
  check(
    'the synthetic PTL assistant error yields',
    r.messages.some(m => m.type === 'assistant' && (m as { isApiErrorMessage?: boolean }).isApiErrorMessage === true && j(m).includes(PROMPT_TOO_LONG_ERROR_MESSAGE)),
  )
  check("Terminal reason 'blocking_limit'", r.terminal?.reason === 'blocking_limit', r.terminal?.reason)
}

section('§5 — a real API PTL surfaces ONCE: no compact attempt, no retry, no stop-hook spiral')
{
  const r = await runQuery({
    turns: [
      {
        kind: 'error',
        status: 400,
        errorType: 'invalid_request_error',
        message: 'prompt is too long: 137500 tokens > 135000 maximum',
      },
    ],
    history: makeHistory(100),
  })
  const reqs = r.api.messageRequests()
  check('exactly one model call — the 413 is never retried and never triggers a compact', reqs.length === 1, `${reqs.length}`)
  const ptl = r.messages.find(
    m => m.type === 'assistant' && (m as { isApiErrorMessage?: boolean }).isApiErrorMessage === true && j(m).includes(PROMPT_TOO_LONG_ERROR_MESSAGE),
  ) as { errorDetails?: string } | undefined
  check('the PTL assistant message yields with the exact generic content', !!ptl)
  check(
    'errorDetails carries the RAW API text with token counts (the reactive-gap contract)',
    !!ptl && typeof ptl.errorDetails === 'string' && ptl.errorDetails.includes('137500'),
    ptl?.errorDetails ?? 'no errorDetails',
  )
  check(
    "Terminal reason 'completed' (the pinned as-is band: API-error messages skip stop hooks and terminalize)",
    r.terminal?.reason === 'completed',
    r.terminal?.reason,
  )
}

section('§6 — consecutive compact failures accumulate; the FOURTH iteration makes NO compact attempt (breaker at 3)')
{
  const failRound: ScriptedTurn[] = [
    { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'ptl compact fixture refusal' },
    { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'ptl compact fixture refusal' },
  ]
  const toolTurn = (id: string): ScriptedTurn => ({ kind: 'tool_use', name: 'PtlProbeTool', input: {}, id })
  const r = await runQuery({
    turns: [
      ...failRound, toolTurn('toolu_ptl_1'),
      ...failRound, toolTurn('toolu_ptl_2'),
      ...failRound, toolTurn('toolu_ptl_3'),
      { kind: 'text', text: 'P6 FINAL TURN — the breaker suppressed round four.' },
    ],
    history: makeHistory(50_000),
    tools: [makeFakeTool()],
    env: { MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '0.001' },
  })
  const reqs = r.api.messageRequests()
  const shapes = reqs.map(q => (isCompactRequest(q) ? 'C' : 'M')).join('')
  check('exactly ten model calls (3 × (fork+fallback+main) + the suppressed-round main)', reqs.length === 10, `${reqs.length}`)
  check(
    'the wire pattern is CCM·CCM·CCM·M — three compact rounds, then the breaker suppresses',
    shapes === 'CCMCCMCCMM',
    shapes,
  )
  check('the final text yields', r.messages.some(m => m.type === 'assistant' && j(m).includes('P6 FINAL TURN')))
  check("Terminal reason 'completed'", r.terminal?.reason === 'completed', r.terminal?.reason)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PTL RECOVERY LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} PTL RECOVERY LAW FAILURE(S)`)
process.exit(1)
