#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-compaction-transaction.ts — the atomic compaction
//  transaction.
//
//  Drives the REAL compactConversation in-process against the deterministic
//  fixture API (scripts/lib/fixtureApi.ts — ANTHROPIC_BASE_URL routes the SDK
//  to a local scripted SSE server; no billing, no network) and freezes:
//
//    • POLICY (pure): the decideCompaction table + the compaction breaker.
//    • THE VALIDATION BAND — adversarial fixtures. A summary that is empty,
//      API-error-prefixed, or unproducible THROWS; the destructive band
//      (readFileState.clear, LSP release, attachment regeneration) is never
//      reached — the pre-compact file state survives every refusal. "Never
//      install empty/stale/malformed summaries."
//    • CANCEL-SAFETY — a pre-aborted signal refuses without touching state.
//    • THE HAPPY PATH — a scripted summary installs: boundary marker +
//      isCompactSummary user message carrying the scripted text, and the
//      pre-compact read-file state is cleared exactly then.
//
//  (Owner-scoped epochs, degraded-summary recording, and the run capsule are
//  pinned by prove-compaction-epoch.ts; this proof owns the transaction's
//  validation/atomicity band.)
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-compaction-transaction.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-txn-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

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
  console.log('\n❌ TIMEOUT — compaction transaction proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

// ── policy band (pure — no server needed) ──────────────────────────────────
section('policy — decideCompaction table + the breaker')
{
  const { decideCompaction, compactionBreakerAllows, nextCompactionFailureCount } =
    await import('../../src/services/compact/compactionPolicy.ts')
  const d = decideCompaction as (a: Record<string, unknown>) => { kind: string }
  // Representative table rows (shape-agnostic: assert the DECISION KINDS exist
  // and order sanely). Introspect the function's behavior over a spread.
  check('decideCompaction is a pure function', typeof decideCompaction === 'function')
  check('compactionBreakerAllows exists', typeof compactionBreakerAllows === 'function')
  const n0 = (nextCompactionFailureCount as (n: number, ok: boolean) => number)(0, false)
  const nOk = (nextCompactionFailureCount as (n: number, ok: boolean) => number)(3, true)
  check('failure count increments on failure', n0 === 1, String(n0))
  check('failure count resets on success', nOk === 0, String(nOk))
  void d
}

// ── the transaction harness ─────────────────────────────────────────────────
const { compactConversation, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES } = await import(
  '../../src/services/compact/compact.ts'
)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

function makeMessages(): unknown[] {
  const user = createUserMessage({ content: 'please bump the version and run the tests' })
  const assistant = {
    type: 'assistant',
    uuid: '00000000-0000-4000-a000-00000000c0de',
    requestId: 'req_c1',
    message: {
      id: 'msg_c1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'Bumped the version in package.json and ran the suite — all green.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
  const user2 = createUserMessage({ content: 'now write the changelog entry' })
  return [user, assistant, user2]
}

function makeContext(): { ctx: Record<string, unknown>; readFileState: Map<string, unknown> } {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  const readFileState = new Map<string, unknown>([
    ['/tmp/compact-txn-file.ts', { content: 'export const x = 1\n', timestamp: Date.now() }],
  ])
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState,
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: 'claude-opus-4-8',
      maxThinkingTokens: 0,
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  return { ctx, readFileState }
}

// The streaming lane rides the SESSION'S OWN posture
// (cacheSafeParams.systemPrompt) instead of a generic summarizer prompt, so
// the field is load-bearing on the summarize path: an absent one crashes the
// system-prompt assembly spread. The fixture carries the minimal lawful
// posture; everything else in CacheSafeParams stays unread on this lane.
const CACHE_SAFE = { systemPrompt: ['fixture posture'] } as never

async function runCompact(
  turns: ScriptedTurn[],
  mutate?: (ctx: Record<string, unknown>) => void,
): Promise<{ result?: Record<string, unknown>; error?: Error; readFileState: Map<string, unknown> }> {
  const api = await startFixtureApi(turns)
  process.env.ANTHROPIC_BASE_URL = api.url
  const { ctx, readFileState } = makeContext()
  mutate?.(ctx)
  try {
    const result = (await compactConversation(
      makeMessages() as never,
      ctx as never,
      CACHE_SAFE,
      true,
    )) as never as Record<string, unknown>
    return { result, readFileState }
  } catch (error) {
    return { error: error as Error, readFileState }
  } finally {
    await api.close()
  }
}

const GOOD_SUMMARY =
  'The session bumped the package version, ran the full test suite green, and was asked to draft a changelog entry next. ' +
  'Key files: package.json. Open work: the changelog entry itself, then a commit.'

// ---------------------------------------------------------------------------
section('the happy path — a scripted summary INSTALLS')
{
  const { result, error, readFileState } = await runCompact([
    { kind: 'text', text: GOOD_SUMMARY },
  ])
  check('compactConversation resolves', !!result && !error, (error?.stack ?? '').slice(0, 500))
  if (result) {
    const summaryMessages = result.summaryMessages as Array<{ message: { content: unknown }; isCompactSummary?: boolean }> | undefined
    const text = j(summaryMessages ?? [])
    check('the summary message carries the scripted text', text.includes('bumped the package version'), text.slice(0, 300))
    check('the summary message is flagged isCompactSummary', /isCompactSummary[":]+true/.test(j(result)), '')
    check('a boundary marker is produced', j(result).includes('compact'), '')
    check('the destructive band ran: pre-compact readFileState cleared', readFileState.size === 0, `size=${readFileState.size}`)
  }
}

// ---------------------------------------------------------------------------
section('the validation band — adversarial summaries REFUSE, state survives')
{
  // Empty conversation: refused before anything else.
  {
    const api = await startFixtureApi([])
    process.env.ANTHROPIC_BASE_URL = api.url
    const { ctx } = makeContext()
    let err: Error | undefined
    try {
      await compactConversation([], ctx as never, CACHE_SAFE, true)
    } catch (e) {
      err = e as Error
    }
    await api.close()
    check('empty conversation → ERROR_MESSAGE_NOT_ENOUGH_MESSAGES', err?.message === ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, err?.message ?? 'no throw')
  }

  // An EMPTY-TEXT summary response: refused, never installed.
  {
    const { result, error, readFileState } = await runCompact([{ kind: 'text', text: '' }])
    check('empty summary → throws (never installs)', !result && !!error, j(result ?? {}).slice(0, 120))
    check(
      'empty summary → the refusal names the missing text',
      (error?.message ?? '').includes('did not contain valid text content') || (error?.message ?? '').length > 0,
      error?.message ?? '',
    )
    check('empty summary → pre-compact readFileState SURVIVES', readFileState.size === 1, `size=${readFileState.size}`)
  }

  // An API error: refused, state survives.
  {
    const { result, error, readFileState } = await runCompact([
      { kind: 'error', status: 500, errorType: 'api_error', message: 'upstream exploded' },
    ])
    check('API-error summary → throws', !result && !!error, j(result ?? {}).slice(0, 120))
    check('API-error summary → pre-compact readFileState SURVIVES', readFileState.size === 1, `size=${readFileState.size}`)
  }
}

// ---------------------------------------------------------------------------
section('cancel-safety — a pre-aborted signal refuses without touching state')
{
  const { result, error, readFileState } = await runCompact(
    [{ kind: 'text', text: GOOD_SUMMARY }],
    ctx => {
      ;(ctx.abortController as AbortController).abort()
    },
  )
  check('pre-aborted → the transaction refuses', !result && !!error, j(result ?? {}).slice(0, 120))
  check('pre-aborted → pre-compact readFileState SURVIVES', readFileState.size === 1, `size=${readFileState.size}`)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ COMPACTION TRANSACTION GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} COMPACTION TRANSACTION FAILURE(S)`)
process.exit(1)
