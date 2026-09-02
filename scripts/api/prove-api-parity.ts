// scripts/api/prove-api-parity.ts — the R6 golden-replay parity oracle for
// src/services/providers/anthropic/index.ts.
//
// Same contract as R2-R5 (scripts/lib/goldenReplay.ts): deterministic
// fixtures through every covered export, byte-diffed against goldens recorded
// from the PRE-REWRITE module; coverage self-accounting.
//
//   bun run scripts/api/prove-api-parity.ts --record
//   bun run scripts/api/prove-api-parity.ts            # gate
//
// Covered: the request-assembly core — cache breakpoints (PRESERVE-CONTRACT:
// breakpoint placement is prompt-cache economics), message→param converters,
// system-prompt block assembly, non-streaming param adjustment, usage
// accumulation, media stripping, output-token ceilings. The network family
// (queryWithModel/queryModelWith*Streaming/verifyApiKey/cleanupStream) is
// SKIP-LISTED — live-API-coupled, pinned by the billed live smokes + the
// standing substrate suites (cache-clock, ultrathink effort wiring).

// The config-read gate ("Config accessed before allowed.") opens under
// NODE_ENV=test — the cache-control/TTL paths read config. The 1h-TTL
// eligibility walk also demands a credential env: a DUMMY key satisfies the
// presence check (the pure subset never issues a request). Set BEFORE import.
process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'sk-ant-oracle-fixture-not-a-real-key'
// Hermetic-state law: the token-ceiling case reads
// this env at CALL time — the operator's ambient 64000 override was baked
// into the recorded golden, which then failed on any clean environment (CI,
// or a clean local shell). Scrub before the cases run; the golden records
// the build's OWN defaults.
delete process.env.MERCURY_MAX_OUTPUT_TOKENS

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as C from '../../src/services/providers/anthropic/index.ts'
import { recordOrVerify, snap, clone } from '../lib/goldenReplay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'goldens.json')
const RECORD = process.argv.includes('--record')

const cases: Record<string, () => unknown> = {}
const covered = new Set<string>()
const add = (exportName: string, caseName: string, fn: () => unknown) => {
  covered.add(exportName)
  cases[`${exportName}/${caseName}`] = fn
}

// ── constants + ceilings ────────────────────────────────────────────────────
add('MAX_NON_STREAMING_TOKENS', 'value', () => C.MAX_NON_STREAMING_TOKENS)
add('getMaxOutputTokensForModel', 'families', () =>
  [
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-fable-5',
  ].map(m => C.getMaxOutputTokensForModel(m)),
)
add('getPromptCachingEnabled', 'probe', () => C.getPromptCachingEnabled())
add('getCacheControl', 'shape', () => snap(() => C.getCacheControl('claude-sonnet-5' as never)))

// ── message→param converters ────────────────────────────────────────────────
const USER = {
  type: 'user',
  uuid: '00000000-0000-4000-8000-000000000001',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
} as never
const ASST = {
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000002',
  timestamp: '2026-01-01T00:00:02.000Z',
  message: {
    id: 'msg_fixture',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi', citations: [] }],
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
} as never

add('userMessageToMessageParam', 'plain', () => C.userMessageToMessageParam(clone(USER)))
add('userMessageToMessageParam', 'with-caching', () =>
  C.userMessageToMessageParam(clone(USER), true),
)
add('assistantMessageToMessageParam', 'plain', () =>
  C.assistantMessageToMessageParam(clone(ASST)),
)
add('assistantMessageToMessageParam', 'with-caching', () =>
  C.assistantMessageToMessageParam(clone(ASST), true),
)

// ── cache breakpoints (the prompt-cache economics contract) ────────────────
add('addCacheBreakpoints', 'placement-caching-on', () => {
  const u2 = clone(USER) as { uuid: string; message: { content: unknown } }
  u2.uuid = '00000000-0000-4000-8000-000000000003'
  u2.message.content = [{ type: 'text', text: 'second turn' }]
  return C.addCacheBreakpoints([clone(USER), clone(ASST), u2] as never, true)
})
add('addCacheBreakpoints', 'caching-off', () =>
  C.addCacheBreakpoints([clone(USER), clone(ASST)] as never, false),
)

// ── system prompt block assembly ────────────────────────────────────────────
add('buildSystemPromptBlocks', 'split-and-cache', () =>
  C.buildSystemPromptBlocks(['first block', 'second block'], true),
)
add('buildSystemPromptBlocks', 'no-cache', () =>
  C.buildSystemPromptBlocks(['only block'], false),
)

// ── param adjustment + budgets ──────────────────────────────────────────────
add('adjustParamsForNonStreaming', 'caps-tokens', () =>
  C.adjustParamsForNonStreaming({
    model: 'claude-sonnet-5',
    max_tokens: 128000,
    messages: [],
  } as never),
)
add('configureTaskBudgetParams', 'passthrough', () =>
  snap(() =>
    C.configureTaskBudgetParams(
      { model: 'claude-sonnet-5', max_tokens: 8000 } as never,
      undefined as never,
    ),
  ),
)

// ── usage accounting ────────────────────────────────────────────────────────
const USAGE_A = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 200,
} as never
const USAGE_B = {
  input_tokens: 5,
  output_tokens: 7,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 300,
} as never
add('accumulateUsage', 'sums', () => C.accumulateUsage(clone(USAGE_A), clone(USAGE_B)))
add('updateUsage', 'shape', () => snap(() => C.updateUsage(clone(USAGE_A), clone(USAGE_B))))

// ── media stripping ─────────────────────────────────────────────────────────
add('stripExcessMediaItems', 'over-limit', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }
  const msgs = Array.from({ length: 3 }, (_, i) => ({
    role: 'user',
    content: [{ type: 'text', text: `m${i}` }, clone(img), clone(img)],
  }))
  return C.stripExcessMediaItems(msgs as never, 2)
})

// ── metadata + extra body ───────────────────────────────────────────────────
add('getAPIMetadata', 'shape', () => {
  // device_id is a per-process hash — mask it; the SHAPE (keys + the
  // user_id JSON structure) is the contract.
  const meta = clone(C.getAPIMetadata()) as { user_id?: string }
  if (typeof meta.user_id === 'string') {
    meta.user_id = meta.user_id.replace(/"device_id":"[0-9a-f]{64}"/, '"device_id":"«hash»"')
  }
  return meta
})
add('getExtraBodyParams', 'probe', () => snap(() => C.getExtraBodyParams()))

// ── skip list (live-API family) ─────────────────────────────────────────────
const NET = 'live-API request path — pinned by billed live smokes + substrate suites (cache-clock, ultrathink effort); exercised on every real turn'
const SKIPPED: Record<string, string> = Object.fromEntries(
  [
    'queryWithModel', 'queryModelWithStreaming', 'queryModelWithoutStreaming',
    'querySmallFast', 'executeNonStreamingRequest', 'verifyApiKey', 'cleanupStream',
  ].map(k => [k, NET]),
)

const runtimeExports = Object.keys(C)
const unaccounted = runtimeExports.filter(k => !covered.has(k) && !(k in SKIPPED))

const results: Record<string, unknown> = {}
for (const [name, fn] of Object.entries(cases)) results[name] = snap(fn)

const failures = recordOrVerify({
  goldenPath: GOLDEN_PATH,
  results,
  record: RECORD,
  coverageFailures: unaccounted,
  passLabel: `api parity: ${Object.keys(results).length} golden case(s), ${covered.size}/${runtimeExports.length} exports covered (${Object.keys(SKIPPED).length} skip-listed)`,
  readFileSync: readFileSync as never,
  writeFileSync: writeFileSync as never,
  existsSync: existsSync as never,
})

console.log(failures === 0 ? '✅ API PARITY GREEN' : `❌ ${failures} API PARITY FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
