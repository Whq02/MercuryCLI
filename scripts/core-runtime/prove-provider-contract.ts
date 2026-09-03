#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-provider-contract.ts —
//  provider-neutral capability contract (the characterization laws
//  implementation-blind,
//  green on the OLD bodies first. Everything here drives the REAL seams
//  in-process (env fakes at the provider identity seam; no network, no PTY):
//
//    • PROVIDER-IDENTITY — the first-party base-URL sniff
//      (utils/model/providers.ts). There is no gateway estate (Bedrock/
//      Vertex/Foundry): getAPIProvider and the foreign USE_*
//      selectors do not exist; the census law below pins their absence.
//    • BETA-GUARD — the baked experimental-betas source fold
//      define (read as isEnvTruthy('1')) permanently suppresses
//      first-party-only betas AND the task_budget request field — the
//      400-class protection the define's own doc (src/utils/model/
//      capabilities.ts) names load-bearing. Pinned so a re-own that
//      un-folds it is law-visible.
//    • BETA-TABLE — getAllModelBetas exact header sets per (model × env),
//      the ANTHROPIC_BETAS passthrough, the tool-search header, SDK-beta
//      filtering/merge, and MEMO FRESHNESS: the memo keys fold in every env
//      input (utils/model/capabilities.ts betasMemoKey), so an env flip
//      resolves fresh; clearBetasCaches survives for auth flips.
//    • MODEL-SWITCHES — modelSupportsTemperature / ISP / thinking / adaptive
//      / structured-outputs / auto-mode tables, incl. the canonical-name
//      quirk (getCanonicalName('claude-opus-4-8') = 'claude-opus-4-6') and
//      the current-generation-before-substring guard that keeps
//      claude-sonnet-5 off the removed budget_tokens shape.
//    • EFFORT-CEILINGS — supportsEffort/Max/XHigh family tables, ceiling
//      composition, the deepthink floor (HERMES_DEEPTHINK_MAX live read),
//      raise-only turn floors, querySource gating.
//    • TOKEN-WINDOW — has1mContext/[1m], 1M-disable, the sonnet-5
//      catalog-default-1M quirk, per-family output-max table.
//    • TOKEN-COUNTING — getTokenUsage synthetic filtering, usage sums, the
//      200k pivot boundary, the sibling-walk anchor law for split parallel
//      tool-call records (tokens.ts:226-261), rough-estimation quirks.
//    • REQUEST-ASSEMBLY — getExtraBodyParams (incl. the LRU-poison clone
//      guard), getAPIMetadata shape, prompt-caching env matrix,
//      getCacheControl, configureEffortParams incl. the numeric-effort
//      silent-drop quirk (requestParams.ts:309).
//    • MESSAGE-PARAM — the user/assistant → MessageParam projection: cache
//      marker on the LAST block only, the thinking-final no-marker quirk,
//      and the clone asymmetry (user no-cache clones the content array,
//      assistant passes it by reference — messageParams.ts:54-59 vs 99-102).
//    • LEAK-CENSUS — the exact file set outside the edge (services/api/**
//      + utils/model/**) still carrying model-name conditionals, plus the
//      RETIREMENT law: zero getAPIProvider/isFirstPartyProvider callers and
//      zero foreign USE_* readers anywhere in src.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-provider-contract.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// ── hermetic env, latched BEFORE any src import (all src imports dynamic) ───
const HERMETIC = mkdtempSync(join(tmpdir(), 'native-core-provider-'))
process.env.MERCURY_CONFIG_DIR = join(HERMETIC, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const k of [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BETAS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'DISABLE_INTERLEAVED_THINKING',
  'MERCURY_DISABLE_1M_CONTEXT',
  'DISABLE_PROMPT_CACHING',
  'DISABLE_PROMPT_CACHING_HAIKU',
  'DISABLE_PROMPT_CACHING_SONNET',
  'DISABLE_PROMPT_CACHING_OPUS',
  'MERCURY_EXTRA_BODY',
  'MERCURY_EXTRA_METADATA',
  'MERCURY_EFFORT_LEVEL',
  'HERMES_DEEPTHINK_MAX',
  'MERCURY_CACHE_TTL',
  'MAX_THINKING_TOKENS',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'MERCURY_AUGUR',
  'MERCURY_AUGUR_TOOL',
  'MERCURY_AUGUR_BRIEF',
  'MERCURY_AUGUR_MODEL',
  'USE_CONNECTOR_TEXT_SUMMARIZATION',
  'USE_API_CONTEXT_MANAGEMENT',
]) {
  delete process.env[k]
}

const SRC = join(import.meta.dir, '..', '..', 'src')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Run fn with the given env keys set, restoring (deleting) them after. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

console.log('native-core T16 — provider-neutral capability contract')

// The config gate: every real entry path calls enableConfigs() before any
// config read (cli.tsx daemon/join paths do it explicitly) — getAPIMetadata
// and the settings-backed seams below read config.
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const prov = await import('../../src/utils/model/providers.js')
const betas = await import('../../src/utils/betas.js')
const B = await import('../../src/constants/betas.js')
const augur = await import('../../src/utils/model/augur.js')
const model = await import('../../src/utils/model/model.js')
const thinking = await import('../../src/utils/thinking.js')
const effort = await import('../../src/utils/effort.js')
const ctx = await import('../../src/utils/context.js')
const tokens = await import('../../src/utils/tokens.js')
const tokEst = await import('../../src/services/tokenEstimation.js')
const rp = await import('../../src/services/providers/anthropic/requestParams.js')
const mp = await import('../../src/services/providers/anthropic/messageParams.js')
const msgs = await import('../../src/utils/messages.js')
const state = await import('../../src/bootstrap/state.js')
const caps = await import('../../src/utils/model/capabilities.js')

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// ── LAW PROVIDER-IDENTITY (the base-URL predicate) ──────────────────────────
{
  check('provider: unset base URL is first-party', prov.isFirstPartyAnthropicBaseUrl())
  check(
    'provider: api.anthropic.com is first-party',
    withEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' }, () => prov.isFirstPartyAnthropicBaseUrl()),
  )
  check(
    'provider: a proxy host is NOT first-party',
    !withEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, () => prov.isFirstPartyAnthropicBaseUrl()),
  )
  check(
    'provider: an unparseable base URL is NOT first-party',
    !withEnv({ ANTHROPIC_BASE_URL: 'not a url' }, () => prov.isFirstPartyAnthropicBaseUrl()),
  )
  check(
    'provider: the control-plane gate rides the base-URL predicate',
    prov.hasAnthropicControlPlane() === true &&
      withEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, () => prov.hasAnthropicControlPlane()) === false,
  )
}

// ── LAW BETA-GUARD (the baked experimental-betas source fold) ───────────
{
  check(
    'beta-guard: first-party-only betas suppressed (folded define)',
    betas.shouldIncludeFirstPartyOnlyBetas() === false,
  )
  check('beta-guard: global cache scope suppressed (folded define)', betas.shouldUseGlobalCacheScope() === false)

  const oc: Record<string, unknown> = {}
  const tbBetas: string[] = []
  rp.configureTaskBudgetParams({ total: 100_000, remaining: 50_000 }, oc as never, tbBetas)
  check(
    'beta-guard: task_budget NEVER configured (beta-only request field, the 400 class)',
    !('task_budget' in oc) && tbBetas.length === 0,
    JSON.stringify({ oc, tbBetas }),
  )
}

// ── LAW BETA-TABLE ──────────────────────────────────────────────────────────
{
  const collect = (env: Record<string, string>, m: string): string[] =>
    withEnv(env, () => {
      betas.clearBetasCaches()
      const out = [...betas.getAllModelBetas(m)]
      betas.clearBetasCaches()
      return out
    })

  const rows: Array<[string, Record<string, string>, string, string[]]> = [
    ['firstParty opus-4-8', {}, 'claude-opus-4-8', [B.CODING_20250219_BETA_HEADER, B.INTERLEAVED_THINKING_BETA_HEADER]],
    ['firstParty haiku (no coding-20250219 beta)', {}, 'claude-haiku-4-5-20251001', [B.INTERLEAVED_THINKING_BETA_HEADER]],
    ['firstParty opus-4-6[1m]', {}, 'claude-opus-4-6[1m]', [B.CODING_20250219_BETA_HEADER, B.CONTEXT_1M_BETA_HEADER, B.INTERLEAVED_THINKING_BETA_HEADER]],
    ['DISABLE_INTERLEAVED_THINKING strips the ISP header', { DISABLE_INTERLEAVED_THINKING: '1' }, 'claude-opus-4-8', [B.CODING_20250219_BETA_HEADER]],
    ['MERCURY_DISABLE_1M_CONTEXT beats the [1m] suffix', { MERCURY_DISABLE_1M_CONTEXT: '1' }, 'claude-opus-4-6[1m]', [B.CODING_20250219_BETA_HEADER, B.INTERLEAVED_THINKING_BETA_HEADER]],
    ['ANTHROPIC_BETAS passthrough splits + trims', { ANTHROPIC_BETAS: ' user-beta-1 , user-beta-2,' }, 'claude-opus-4-8', [B.CODING_20250219_BETA_HEADER, B.INTERLEAVED_THINKING_BETA_HEADER, 'user-beta-1', 'user-beta-2']],
  ]
  const seen: string[][] = []
  for (const [label, env, m, want] of rows) {
    const got = collect(env, m)
    seen.push(got)
    check(`beta-table: ${label}`, eq(got, want), JSON.stringify({ got, want }))
  }
  // The suppressed set stays suppressed across every row (the guard's teeth).
  const forbidden = [
    B.REDACT_THINKING_BETA_HEADER,
    B.CONTEXT_MANAGEMENT_BETA_HEADER,
    B.PROMPT_CACHING_SCOPE_BETA_HEADER,
    B.STRUCTURED_OUTPUTS_BETA_HEADER,
    augur.AUGUR_BETA_HEADER,
  ]
  for (const f of forbidden) {
    check(
      `beta-table: '${f}' never emitted on any row`,
      seen.every(row => !row.includes(f)),
    )
  }

  check(
    'beta-table: headers ≡ getAllModelBetas (no partition since the gateway retirement)',
    eq(betas.getModelBetas('claude-opus-4-8'), betas.getAllModelBetas('claude-opus-4-8')),
  )

  check(
    'beta-table: the tool-search header is the advanced-tool-use flavor',
    betas.getToolSearchBetaHeader() === B.TOOL_SEARCH_BETA_HEADER_1P,
  )

  // MEMO FRESHNESS — the resolve-once fix. Pre- the memo
  // key was the model id alone and this block pinned the resulting STALENESS
  // (an env flip served the previous headers until clearBetasCaches). The
  // cut keys the memo on every env input the resolution reads, so the
  // flip now resolves FRESH — the law asserts the fix. clearBetasCaches
  // stays for the non-env inputs (subscriber/auth flips) and is re-proved
  // functional below.
  betas.clearBetasCaches()
  const before = betas.getAllModelBetas('claude-opus-4-8')
  const flipped = withEnv({ DISABLE_INTERLEAVED_THINKING: '1' }, () => betas.getAllModelBetas('claude-opus-4-8'))
  check(
    'beta-table: an env flip resolves FRESH — no stale memo (T16 resolve-once)',
    !flipped.includes(B.INTERLEAVED_THINKING_BETA_HEADER) && before.includes(B.INTERLEAVED_THINKING_BETA_HEADER),
  )
  check(
    'beta-table: flipping back re-serves the base list unchanged',
    eq(betas.getAllModelBetas('claude-opus-4-8'), before),
  )
  const cleared = withEnv({ DISABLE_INTERLEAVED_THINKING: '1' }, () => {
    betas.clearBetasCaches()
    const out = [...betas.getAllModelBetas('claude-opus-4-8')]
    betas.clearBetasCaches()
    return out
  })
  check('beta-table: clearBetasCaches still functions (auth-flip seam)', !cleared.includes(B.INTERLEAVED_THINKING_BETA_HEADER))

  // SDK-beta filtering + merge (the allowlist is CONTEXT_1M only).
  check('sdk-betas: undefined/empty pass through as undefined', betas.filterAllowedSdkBetas(undefined) === undefined && betas.filterAllowedSdkBetas([]) === undefined)
  check(
    'sdk-betas: only the 1M header survives the allowlist',
    eq(betas.filterAllowedSdkBetas([B.CONTEXT_1M_BETA_HEADER, 'evil-beta']), [B.CONTEXT_1M_BETA_HEADER]),
  )
  check('sdk-betas: nothing allowed ⇒ undefined', betas.filterAllowedSdkBetas(['evil-beta']) === undefined)
  const savedSdk = state.getSdkBetas()
  state.setSdkBetas([B.CONTEXT_1M_BETA_HEADER])
  betas.clearBetasCaches()
  const merged = betas.getMergedBetas('claude-opus-4-8')
  check(
    'sdk-betas: merge appends without duplicates',
    merged.filter(b => b === B.CONTEXT_1M_BETA_HEADER).length === 1 && merged.includes(B.CODING_20250219_BETA_HEADER),
    JSON.stringify(merged),
  )
  state.setSdkBetas(savedSdk as never)
  betas.clearBetasCaches()
  const agentic = betas.getMergedBetas('claude-haiku-4-5-20251001', { isAgenticQuery: true })
  check(
    'sdk-betas: an agentic Haiku query gets the coding-20250219 beta APPENDED',
    eq(agentic, [B.INTERLEAVED_THINKING_BETA_HEADER, B.CODING_20250219_BETA_HEADER]),
    JSON.stringify(agentic),
  )
  betas.clearBetasCaches()
}

// ── LAW MODEL-SWITCHES ──────────────────────────────────────────────────────
{
  // The canonical-name quirk the whole switch layer rides on.
  const canon: Array<[string, string]> = [
    ['claude-opus-4-8', 'claude-opus-4-6'],
    ['claude-opus-4-6', 'claude-opus-4-6'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet'],
  ]
  for (const [id, want] of canon) {
    check(`canonical: ${id} → ${want}`, model.getCanonicalName(id as never) === want, model.getCanonicalName(id as never))
  }

  const temp: Array<[string, boolean]> = [
    ['claude-sonnet-5', false], // 5-family: param PRESENCE 400s
    ['claude-fable-5', false],
    ['claude-opus-4-8', false], // opus minor ≥7 removed sampling params
    ['claude-opus-4-7', false],
    ['claude-opus-4-6', true],
    ['claude-opus-4-20250514', true], // dated snapshot reads minor 0, not the date
    ['claude-3-7-sonnet-20250219', true], // legacy shape: no match ⇒ supported
    ['gpt-4o', true], // non-claude: no match ⇒ supported
  ]
  for (const [m, want] of temp) {
    check(`temperature: ${m} → ${want}`, betas.modelSupportsTemperature(m) === want)
  }

  check('isp: claude-3-* unsupported', !betas.modelSupportsISP('claude-3-7-sonnet-20250219'))
  check('isp: opus-4-8 supported', betas.modelSupportsISP('claude-opus-4-8'))
  check('isp: haiku-4-5 supported (Claude 4+ family)', betas.modelSupportsISP('claude-haiku-4-5-20251001'))

  check('thinking: claude-3-* unsupported', !thinking.modelSupportsThinking('claude-3-7-sonnet-20250219'))
  check('thinking: opus-4-8 supported', thinking.modelSupportsThinking('claude-opus-4-8'))
  check('thinking: haiku-4-5 supported (Claude 4+ family)', thinking.modelSupportsThinking('claude-haiku-4-5-20251001'))

  check(
    'adaptive: claude-sonnet-5 via the catalog BEFORE the sonnet-substring exclusion (the budget_tokens 400 guard)',
    thinking.modelSupportsAdaptiveThinking('claude-sonnet-5'),
  )
  check(
    'adaptive: opus-4-8 rides the canonical opus-4-6 allowlist row',
    thinking.modelSupportsAdaptiveThinking('claude-opus-4-8'),
  )
  check('adaptive: opus-4-5 excluded (legacy family row)', !thinking.modelSupportsAdaptiveThinking('claude-opus-4-5'))
  check('adaptive: unknown id defaults TRUE (quality floor)', thinking.modelSupportsAdaptiveThinking('zz-unknown-model-a'))

  check('structured: sonnet-4-6 supported', betas.modelSupportsStructuredOutputs('claude-sonnet-4-6'))
  check('structured: sonnet-5 via the catalog', betas.modelSupportsStructuredOutputs('claude-sonnet-5'))

  check('auto-mode: opus-4-8 allowed (canonical 4-6 row)', betas.modelSupportsAutoMode('claude-opus-4-8'))
}

// ── LAW EFFORT-CEILINGS ─────────────────────────────────────────────────────
{
  const table: Array<[string, boolean, boolean, boolean]> = [
    // [model, supportsEffort, supportsMax, supportsXHigh]
    ['claude-opus-4-8', true, true, true],
    ['claude-opus-4-6', true, true, false],
    ['claude-sonnet-4-6', true, true, false],
    ['claude-sonnet-4-5', false, false, false],
    ['claude-haiku-4-5-20251001', false, false, false],
    ['claude-fable-5', true, true, true],
    ['claude-sonnet-5', true, true, true], // current-generation caps
    ['claude-opus-5', true, true, true], // current-generation caps
  ]
  for (const [m, e, mx, xh] of table) {
    check(
      `effort: ${m} → effort=${e} max=${mx} xhigh=${xh}`,
      effort.modelSupportsEffort(m) === e &&
        effort.modelSupportsMaxEffort(m) === mx &&
        effort.modelSupportsXHighEffort(m) === xh,
    )
  }
  check('effort: unknown id defaults TRUE', effort.modelSupportsEffort('zz-unknown-model-c'))
  check(
    'effort: ceiling composition max > xhigh > high',
    effort.getMaxSupportedEffortLevel('claude-opus-4-8') === 'max' &&
      effort.getMaxSupportedEffortLevel('claude-haiku-4-5-20251001') === 'high' &&
      effort.getMaxSupportedEffortLevel('claude-sonnet-5') === 'max',
  )
  // ALIGNED: the deepthink keyword is a prose nudge —
  // the turn-effort floor API is retired and must stay dead.
  check(
    'effort: the turn-effort floor API is retired',
    !('setTurnEffortFloor' in effort) &&
      !('getTurnEffortFloor' in effort) &&
      !('getDeepthinkFloorLevel' in effort) &&
      !('resolveDeepthinkTurnEffort' in effort),
  )
  check(
    'effort: turn-owning source scoping survives for the tier lifecycle',
    effort.isTurnOwningQuerySource('repl_main_thread_1') === true &&
      effort.isTurnOwningQuerySource('sdk') === true &&
      effort.isTurnOwningQuerySource('agent:x') === true &&
      effort.isTurnOwningQuerySource('compact') === false &&
      effort.isTurnOwningQuerySource(undefined) === false,
  )
}

// ── LAW TOKEN-WINDOW ────────────────────────────────────────────────────────
{
  check('window: [1m] suffix sniff is case-insensitive', ctx.has1mContext('claude-opus-4-6[1M]') && ctx.has1mContext('claude-opus-4-6[1m]'))
  check('window: no suffix ⇒ no 1m', !ctx.has1mContext('claude-opus-4-6'))
  check(
    'window: MERCURY_DISABLE_1M_CONTEXT kills the suffix too',
    withEnv({ MERCURY_DISABLE_1M_CONTEXT: '1' }, () => !ctx.has1mContext('claude-opus-4-6[1m]')),
  )
  check(
    'window: modelSupports1M family table (sonnet-4 · opus-4-6 · fable-5 yes; haiku no)',
    ctx.modelSupports1M('claude-sonnet-4-6') &&
      ctx.modelSupports1M('claude-opus-4-6') &&
      ctx.modelSupports1M('claude-fable-5') &&
      !ctx.modelSupports1M('claude-haiku-4-5-20251001'),
  )
  check('window: [1m] ⇒ 1,000,000', ctx.getContextWindowForModel('claude-opus-4-6[1m]') === 1_000_000)
  check('window: plain opus-4-6 ⇒ 200,000', ctx.getContextWindowForModel('claude-opus-4-6') === 200_000)
  check(
    'window: claude-sonnet-5 defaults to 1M via the catalog — NO suffix needed (quirk)',
    ctx.getContextWindowForModel('claude-sonnet-5') === 1_000_000,
  )
  check(
    'window: the 1M-disable caps a catalog 1M model back to 200k',
    withEnv({ MERCURY_DISABLE_1M_CONTEXT: '1' }, () => ctx.getContextWindowForModel('claude-sonnet-5')) === 200_000,
  )
  check(
    'window: the CONTEXT_1M beta widens a supporting model',
    ctx.getContextWindowForModel('claude-sonnet-4-6', [B.CONTEXT_1M_BETA_HEADER]) === 1_000_000,
  )

  const outMax: Array<[string, number, number]> = [
    ['claude-fable-5', 64_000, 128_000],
    ['claude-opus-4-6', 64_000, 128_000],
    ['claude-sonnet-4-6', 32_000, 128_000],
    ['claude-opus-4-5', 32_000, 64_000],
    ['claude-opus-4-1', 32_000, 32_000],
    ['claude-3-5-sonnet-20241022', 8_192, 8_192],
    ['claude-sonnet-5', 64_000, 128_000], // catalog: min(64k, outputMax)
    ['zz-unknown-model', 32_000, 64_000], // the default row
  ]
  for (const [m, def, upper] of outMax) {
    const got = ctx.getModelMaxOutputTokens(m)
    check(`window: output-max ${m} → {${def}, ${upper}}`, got.default === def && got.upperLimit === upper, JSON.stringify(got))
  }
  check(
    'window: max thinking budget = upper limit − 1',
    ctx.getMaxThinkingTokensForModel('claude-opus-4-6') === 127_999,
  )
  check(
    'window: percentage math — null usage ⇒ nulls, clamped at 100',
    eq(ctx.calculateContextPercentages(null, 200_000), { used: null, remaining: null }) &&
      eq(
        ctx.calculateContextPercentages(
          { input_tokens: 500_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          200_000,
        ),
        { used: 100, remaining: 0 },
      ),
  )
}

// ── LAW TOKEN-COUNTING (pure Message[] laws) ────────────────────────────────
{
  const usage = (input: number, output: number, cc = 0, cr = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cc,
    cache_read_input_tokens: cr,
  })
  const asst = (id: string, u: ReturnType<typeof usage>, text = 'hello world'): unknown => ({
    type: 'assistant',
    message: { id, model: 'claude-opus-4-8', usage: u, content: [{ type: 'text', text }] },
  })
  const user = (text: string): unknown => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

  const real = asst('m1', usage(100, 10, 5, 7))
  check('counting: real assistant usage surfaces', eq(tokens.getTokenUsage(real as never), usage(100, 10, 5, 7)))
  const syntheticModel = { ...(asst('m2', usage(1, 1)) as Record<string, unknown>) } as { message: Record<string, unknown> }
  syntheticModel.message = { ...syntheticModel.message, model: msgs.SYNTHETIC_MODEL }
  check('counting: the synthetic model is filtered', tokens.getTokenUsage(syntheticModel as never) === undefined)
  const syntheticText = [...msgs.SYNTHETIC_MESSAGES][0] as string
  check(
    'counting: a synthetic message text is filtered',
    tokens.getTokenUsage(asst('m3', usage(1, 1), syntheticText) as never) === undefined,
  )
  check('counting: usage sum includes both cache families', tokens.getTokenCountFromUsage(usage(100, 10, 5, 7) as never) === 122)

  check(
    'counting: the 200k pivot is strictly-greater (200,000 exactly is NOT over)',
    tokens.doesMostRecentAssistantMessageExceed200k([asst('m4', usage(199_990, 10))] as never) === false &&
      tokens.doesMostRecentAssistantMessageExceed200k([asst('m5', usage(199_991, 10))] as never) === true,
  )
  check('counting: no assistant ⇒ not over', tokens.doesMostRecentAssistantMessageExceed200k([user('x')] as never) === false)

  // SIBLING-WALK (tokens.ts contextFill): split records of ONE API response
  // share message.id; estimation must anchor at the FIRST sibling so
  // interleaved tool_results are counted. The law: total = usage(sum) +
  // rough(everything AFTER the first sibling that is NOT a sibling) once the
  // usage is SETTLED (the record carries a stop_reason — the wire's final
  // usage already covers every sibling's output); an UNSETTLED record (a
  // message_start snapshot, no stop_reason) keeps the siblings estimated so
  // in-flight output is never dropped.
  const a1 = asst('resp-A', usage(1000, 50), 'first split block')
  const t1 = user('tool result one')
  const a2 = asst('resp-A', usage(1000, 50), 'second split block')
  const t2 = user('tool result two')
  const seq = [user('prompt'), a1, t1, a2, t2]
  const wantUnsettled =
    tokens.getTokenCountFromUsage(usage(1000, 50) as never) +
    tokEst.roughTokenCountEstimationForMessages([t1, a2, t2] as never)
  check(
    'counting: sibling-walk anchors estimation at the FIRST split record (unsettled: siblings estimated)',
    tokens.tokenCountWithEstimation(seq as never) === wantUnsettled,
    `${tokens.tokenCountWithEstimation(seq as never)} vs ${wantUnsettled}`,
  )
  const a2Settled = { ...(a2 as Record<string, unknown>), message: { ...((a2 as { message: Record<string, unknown> }).message), stop_reason: 'tool_use' } }
  const settledSeq = [user('prompt'), a1, t1, a2Settled, t2]
  const wantSettled =
    tokens.getTokenCountFromUsage(usage(1000, 50) as never) +
    tokEst.roughTokenCountEstimationForMessages([t1, t2] as never)
  check(
    'counting: a SETTLED usage counts the sibling split exactly once (its output is inside output_tokens)',
    tokens.tokenCountWithEstimation(settledSeq as never) === wantSettled,
    `${tokens.tokenCountWithEstimation(settledSeq as never)} vs ${wantSettled}`,
  )
  check(
    'counting: an all-zero usage record is the per-block placeholder, not usage',
    tokens.getTokenUsage(asst('m6', usage(0, 0)) as never) === undefined,
  )
  check(
    'counting: no usage anywhere ⇒ pure estimation fallback',
    tokens.tokenCountWithEstimation([user('abcd'), user('efgh')] as never) ===
      tokEst.roughTokenCountEstimationForMessages([user('abcd'), user('efgh')] as never),
  )

  check('counting: rough estimation is length/4 rounded', tokEst.roughTokenCountEstimation('abcdefghij') === 3)
  check(
    'counting: dense-JSON file types estimate at 2 bytes/token (quirk)',
    tokEst.bytesPerTokenForFileType('json') === 2 &&
      tokEst.bytesPerTokenForFileType('jsonl') === 2 &&
      tokEst.bytesPerTokenForFileType('ts') === 4,
  )
  check(
    'counting: file-type estimation composes the ratio',
    tokEst.roughTokenCountEstimationForFileType('abcdefghij', 'json') === 5,
  )
}

// ── LAW REQUEST-ASSEMBLY ────────────────────────────────────────────────────
{
  check('assembly: no env + no betas ⇒ empty extra body', eq(rp.getExtraBodyParams(), {}))
  check('assembly: betas land as anthropic_beta', eq(rp.getExtraBodyParams(['x-beta']), { anthropic_beta: ['x-beta'] }))
  withEnv({ MERCURY_EXTRA_BODY: '{"anthropic_beta":["pre"],"k":1}' }, () => {
    check(
      'assembly: extra-body merge dedups into the existing anthropic_beta',
      eq(rp.getExtraBodyParams(['pre', 'new']), { anthropic_beta: ['pre', 'new'], k: 1 }),
    )
    check(
      'assembly: the LRU-poison clone guard — a later call is NOT contaminated',
      eq(rp.getExtraBodyParams(), { anthropic_beta: ['pre'], k: 1 }),
    )
  })
  withEnv({ MERCURY_EXTRA_BODY: '[1,2]' }, () => {
    check('assembly: a non-object extra body is ignored', eq(rp.getExtraBodyParams(['b']), { anthropic_beta: ['b'] }))
  })
  withEnv({ MERCURY_EXTRA_BODY: 'not json' }, () => {
    check('assembly: unparseable extra body is ignored', eq(rp.getExtraBodyParams(), {}))
  })

  const meta = rp.getAPIMetadata() as { user_id: string }
  const parsed = JSON.parse(meta.user_id) as Record<string, unknown>
  check(
    'assembly: metadata user_id is JSON with device/account/session identity',
    typeof parsed.device_id === 'string' &&
      'account_uuid' in parsed &&
      typeof parsed.session_id === 'string',
    meta.user_id,
  )
  withEnv({ MERCURY_EXTRA_METADATA: '{"team":"t16"}' }, () => {
    const withExtra = JSON.parse((rp.getAPIMetadata() as { user_id: string }).user_id) as Record<string, unknown>
    check('assembly: extra metadata merges into user_id', withExtra.team === 't16')
  })

  check('assembly: prompt caching defaults ON', rp.getPromptCachingEnabled('claude-opus-4-8'))
  check(
    'assembly: DISABLE_PROMPT_CACHING is global',
    withEnv({ DISABLE_PROMPT_CACHING: '1' }, () => !rp.getPromptCachingEnabled('claude-opus-4-8')),
  )
  check(
    'assembly: the haiku-targeted disable only hits the small-fast model',
    withEnv({ DISABLE_PROMPT_CACHING_HAIKU: '1' }, () => rp.getPromptCachingEnabled('claude-opus-4-8')),
  )

  // getCacheControl: hermetic home ⇒ not a subscriber ⇒ 5m ephemeral.
  check('assembly: default cache control is bare ephemeral', eq(rp.getCacheControl(), { type: 'ephemeral' }))

  const supported: Record<string, unknown> = {}
  const supportedBetas: string[] = []
  rp.configureEffortParams('max', supported as never, {}, supportedBetas, 'claude-opus-4-8')
  check(
    'assembly: a supported model sends effort + the effort beta',
    eq(supported, { effort: 'max' }) && supportedBetas.length === 1,
    JSON.stringify({ supported, supportedBetas }),
  )
  const noValue: Record<string, unknown> = {}
  const noValueBetas: string[] = []
  rp.configureEffortParams(undefined, noValue as never, {}, noValueBetas, 'claude-opus-4-8')
  check(
    'assembly: undefined effort on a supported model sends the beta only',
    eq(noValue, {}) && noValueBetas.length === 1,
  )
  const unsupported: Record<string, unknown> = {}
  const unsupportedBetas: string[] = []
  rp.configureEffortParams('high', unsupported as never, {}, unsupportedBetas, 'claude-haiku-4-5-20251001')
  check(
    'assembly: an unsupported model drops BOTH the param and the beta',
    eq(unsupported, {}) && unsupportedBetas.length === 0,
  )
  const numeric: Record<string, unknown> = {}
  const numericBetas: string[] = []
  rp.configureEffortParams(5000 as never, numeric as never, {}, numericBetas, 'claude-opus-4-8')
  check(
    'assembly: NUMERIC effort silently drops param AND beta (quirk, requestParams.ts:309)',
    eq(numeric, {}) && numericBetas.length === 0,
  )
  const preset: Record<string, unknown> = { effort: 'low' }
  const presetBetas: string[] = []
  rp.configureEffortParams('max', preset as never, {}, presetBetas, 'claude-opus-4-8')
  check(
    'assembly: a pre-set effort in outputConfig is never overwritten',
    preset.effort === 'low' && presetBetas.length === 0,
  )
}

// ── LAW MESSAGE-PARAM (the projection + cache-marker placement) ─────────────
{
  const userMsg = (content: unknown): unknown => ({ type: 'user', message: { role: 'user', content } })
  const asstMsg = (content: unknown): unknown => ({ type: 'assistant', message: { role: 'assistant', content } })
  type Block = { type: string; text?: string; cache_control?: unknown }

  const uStr = mp.userMessageToMessageParam(userMsg('hi there') as never, true, true)
  check(
    'message-param: user string + cache wraps into ONE marked text block',
    Array.isArray(uStr.content) &&
      uStr.content.length === 1 &&
      (uStr.content[0] as Block).type === 'text' &&
      eq((uStr.content[0] as Block).cache_control, { type: 'ephemeral' }),
    JSON.stringify(uStr),
  )
  const blocks = [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
    { type: 'text', text: 'c' },
  ]
  const uArr = mp.userMessageToMessageParam(userMsg(blocks) as never, true, true)
  const marked = (uArr.content as Block[]).map(b => 'cache_control' in b)
  check('message-param: array + cache marks the LAST block only', eq(marked, [false, false, true]), JSON.stringify(marked))
  const uNoCache = mp.userMessageToMessageParam(userMsg(blocks) as never, true, false)
  check(
    'message-param: enablePromptCaching=false ⇒ zero cache_control keys',
    (uNoCache.content as Block[]).every(b => !('cache_control' in b)),
  )

  const shared = [{ type: 'text', text: 'shared' }]
  const uPlain = mp.userMessageToMessageParam(userMsg(shared) as never, false, true)
  check(
    'message-param: user no-cache CLONES the content array (splice-contamination guard)',
    uPlain.content !== shared && (uPlain.content as Block[])[0] === shared[0],
  )
  const aPlain = mp.assistantMessageToMessageParam(asstMsg(shared) as never, false, true)
  check(
    'message-param: assistant no-cache passes content BY REFERENCE (asymmetry quirk)',
    aPlain.content === shared,
  )

  const thinkingLast = [
    { type: 'text', text: 'answer' },
    { type: 'thinking', thinking: 'hmm', signature: 's' },
  ]
  const aThink = mp.assistantMessageToMessageParam(asstMsg(thinkingLast) as never, true, true)
  check(
    'message-param: a thinking-final assistant message gets NO cache marker at all (quirk)',
    (aThink.content as Block[]).every(b => !('cache_control' in b)),
    JSON.stringify(aThink),
  )
  const textLast = [
    { type: 'thinking', thinking: 'hmm', signature: 's' },
    { type: 'text', text: 'answer' },
  ]
  const aText = mp.assistantMessageToMessageParam(asstMsg(textLast) as never, true, true)
  check(
    'message-param: a text-final assistant message marks the last block',
    eq((aText.content as Block[]).map(b => 'cache_control' in b), [false, true]),
  )
}

// ── LAW RECORD-TOTALITY (the capability record ≡ its constituents) ──────
{
  const models = ['claude-opus-4-8', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-6[1m]']
  betas.clearBetasCaches()
  for (const m of models) {
    const r = caps.resolveModelCapabilities(m)
    const out = ctx.getModelMaxOutputTokens(m)
    const agrees =
      r.model === m &&
      r.canonical === model.getCanonicalName(m as never) &&
      r.identity.isHaiku === model.getCanonicalName(m as never).includes('haiku') &&
      r.identity.knowledgeCutoff === caps.getModelKnowledgeCutoff(m) &&
      r.context.window === ctx.getContextWindowForModel(m) &&
      r.context.supports1m === ctx.modelSupports1M(m) &&
      r.context.outputDefault === out.default &&
      r.context.outputMax === out.upperLimit &&
      r.context.maxThinkingTokens === ctx.getMaxThinkingTokensForModel(m) &&
      r.thinking.supported === thinking.modelSupportsThinking(m) &&
      r.thinking.adaptive === thinking.modelSupportsAdaptiveThinking(m) &&
      r.thinking.interleaved === betas.modelSupportsISP(m) &&
      r.sampling.temperature === betas.modelSupportsTemperature(m) &&
      r.effort.supported === effort.modelSupportsEffort(m) &&
      r.effort.max === effort.modelSupportsMaxEffort(m) &&
      r.effort.xhigh === effort.modelSupportsXHighEffort(m) &&
      r.effort.ceiling === effort.getMaxSupportedEffortLevel(m) &&
      r.tools.structuredOutputs === betas.modelSupportsStructuredOutputs(m) &&
      r.tools.contextManagement === betas.modelSupportsContextManagement(m) &&
      r.tools.autoMode === betas.modelSupportsAutoMode(m) &&
      r.tools.toolSearchBetaHeader === betas.getToolSearchBetaHeader() &&
      r.tools.advisor === caps.modelSupportsAdvisor(m) &&
      r.media.pdf === caps.modelSupportsPDF(m) &&
      eq(r.betas.all, betas.getAllModelBetas(m)) &&
      eq(r.betas.headers, betas.getModelBetas(m))
    check(`record: total agreement with constituents — ${m}`, agrees, JSON.stringify(r))
  }
  betas.clearBetasCaches()
  const frozen = caps.resolveModelCapabilities('claude-opus-4-8')
  check(
    'record: frozen at every level',
    Object.isFrozen(frozen) && Object.isFrozen(frozen.context) && Object.isFrozen(frozen.betas.all),
  )
  // The record is a fresh resolution per call — an env flip between two
  // resolutions yields the flipped truth (the anti-staleness law).
  const base = caps.resolveModelCapabilities('claude-opus-4-6[1m]')
  const disabled = withEnv({ MERCURY_DISABLE_1M_CONTEXT: '1' }, () =>
    caps.resolveModelCapabilities('claude-opus-4-6[1m]'),
  )
  check(
    'record: resolves FRESH per (model, env) — no cross-env bleed',
    base.context.window === 1_000_000 && disabled.context.window === 200_000,
  )
  betas.clearBetasCaches()
}

// ── LAW LEAK-CENSUS ──────
{
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(p)
    }
    return out
  }
  const outsideEdge = walk(SRC)
    .map(p => relative(SRC, p))
    .filter(p => !p.startsWith('services/api/') && !p.startsWith('utils/model/'))
    .sort()

  const grep = (re: RegExp): string[] =>
    outsideEdge.filter(p => re.test(readFileSync(join(SRC, p), 'utf8'))).map(p => `src/${p}`)

  // Model-name conditionals outside the edge — TODAY'S TRUTH (23 files at the
  // contract-layer derivation; an earlier count undercounted at 12). The T16
  // cut converts the true leaks to capability-record reads and DECLARES the
  // deliberate ones; either way a file leaving or joining this list is a
  // conscious act.
  // cut, step 1: the capability decision bodies moved into
  // the ONE edge module src/utils/model/capabilities.ts — utils/betas.ts is
  // now a pure re-export barrel; utils/thinking.ts and utils/context.ts keep
  // only policy/math and re-export the capability surface. utils/effort.ts
  // REMAINS below deliberately: its residual matches are launch-pin/default
  // POLICY tables keyed by family (deliberate model-awareness by
  // design), not capability truth — the capability tables themselves moved.
  // cut, step 4: the true-leak consumers left too — WebSearchTool +
  // pdfUtils + advisor + constants/prompts now read
  // the record / edge functions. What REMAINS is the declared-deliberate set:
  // UI labels + seat boards (model.tsx, EffortCallout,
  // TeammateChatsView) · the fable model-aware pack trio · presentation
  // tables (commitAttribution) · pattern look-alikes that are not model-name
  // conditionals at all (completionCache's 'claude completion' marker,
  // pidLock's process-command sniff, setupGitHubActions' workflow-name list)
  // · mocking (rateLimitMocking) · effort.ts launch-pin policy (above).
  // cut (batch 3): state.ts's slow-op label sniff DIED with the deleted
  // slow-ops family — the census shrinks 14→13.
  // two cuts in one day (13→11): — the seat board's local
  // nextModelOf family table DIED, the seat-model cycle consolidated into the
  // ONE resolver (utils/model/seatSlots.ts, inside the sanctioned model edge;
  // exactly the consolidation this census rewards) · Depromotion —
  // setupGitHubActions.ts DIED with the removed /install-github-app
  // external-product installer.
  // The wrapper-pack estate died — tierOverlay's
  // + wrapperPack's model-name conditionals left with it (the tier
  // classification moved INSIDE the sanctioned model edge: seatSlots.ts).
  // The census is compared SET-wise on sorted spellings — the walk sorts, so
  // the pin must too (the old hand-ordered list went red purely on order).
  // The seat board (TeammateChatsView) left the census: its labels read the
  // resolver and the file carries no model-name conditional any more.
  const MODEL_NAME_CENSUS = [
    'src/commands/model/model.tsx',
    // The first-party usage owner: the weekly pools the endpoint meters are
    // PER FAMILY by the provider's own contract (a Fable week never caps a
    // Sonnet turn), so binding a pool to the family word inside a model id
    // is the pool's identity, not a capability leak — declared deliberate.
    'src/services/claudeAiLimits.ts',
    // A1: the typed PrimaryAgentBackend contract — a
    // provider-EDGE module by construction (family classification for the
    // typed AgentRuntimeRef lives at the edge, exactly what this census
    // rewards).
    'src/services/providers/primaryBackend.ts',
    'src/services/rateLimitMocking.ts',
    // commitAttribution.ts is not a census member (the watermark is
    // provider-neutral — no model-name tables).
    // completionCache does not exist (no constant-false
    // build-variant graph).
    'src/utils/effort.ts',
    'src/utils/nativeInstaller/pidLock.ts',
  ].sort()
  const modelNameFound = grep(/includes\('(?:opus|sonnet|haiku|claude)/)
  check(
    `census: model-name conditionals outside the edge = the ${MODEL_NAME_CENSUS.length} characterized files`,
    eq(modelNameFound, MODEL_NAME_CENSUS),
    JSON.stringify({
      unexpected: modelNameFound.filter(f => !MODEL_NAME_CENSUS.includes(f)),
      missing: MODEL_NAME_CENSUS.filter(f => !modelNameFound.includes(f)),
    }),
  )

  // RETIREMENT law: the provider-selection seam
  // is ABSENT. Zero getAPIProvider/isFirstPartyProvider callers and zero
  // foreign USE_* readers anywhere in src — a reappearance flips this.
  const allSrc = walk(SRC).map(p => relative(SRC, p)).sort()
  const grepAll = (re: RegExp): string[] =>
    allSrc.filter(p => re.test(readFileSync(join(SRC, p), 'utf8'))).map(p => `src/${p}`)
  const providerFound = grepAll(/getAPIProvider\(|isFirstPartyProvider\(/)
  check(
    'census: zero getAPIProvider/isFirstPartyProvider callers in src (retired seam)',
    providerFound.length === 0,
    JSON.stringify(providerFound),
  )
  const FOREIGN = ['CLAUDE', 'CODE'].join('_')
  const envLeaks = grepAll(new RegExp(['USE_BEDROCK', 'USE_VERTEX', 'USE_FOUNDRY'].map(n => `${FOREIGN}_${n}`).join('|')))
  check(
    'census: zero foreign USE_* readers in src (retired selectors)',
    envLeaks.length === 0,
    JSON.stringify(envLeaks),
  )
}

rmSync(HERMETIC, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nnative-core provider contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core provider contract: green (${checks} checks)`)
