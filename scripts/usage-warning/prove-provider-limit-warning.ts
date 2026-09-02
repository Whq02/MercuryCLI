#!/usr/bin/env bun
// ============================================================================
//  prove-provider-limit-warning — the yellow strip warning fires for
//  WHICHEVER provider the session runs on, from that provider's own
//  signals, in the one ruled grammar "<provider>: XX% of <window> used".
//
//    §1 ANTHROPIC — the existing meters (per-family claims included: the
//       FABLE bucket names itself), the allowed_warning + ≥70% gate, the
//       overage-close special case, the api-key-shape mute; THE POOL
// FEEDER: the per-model weekly pools the usage
//       endpoint states (Fable · Opus · Sonnet) fold into the ONE record
//       and warn beside the shared windows — Fable at 99% beside a calm
//       51% week paints the Fable line (the base folded only 5h/7d and
//       painted nothing: a green pin over a red fact, since the injected
//       Fable record above is a shape the live header decoder never mints).
//    §2 OPENAI — the observed x-codex bands feed the warning; below the
//       threshold, silence.
//    §3 OPENROUTER — the polled credit cap's APPROACHING tier (the
//       402/exhaustion honesty already lives on the dispatch path); an
//       uncapped key serves no percent ⇒ no warning, honestly.
//    §4 KIMI — the managed account's stated windows warn as Kimi.
//    §5 HONEST NOTHING — every lane whose wire serves no percent-shaped
//       usage signal (gemini · huggingface · local · zai · deepseek ·
//       compat · moonshot key) warns never, credentialed or not.
//    §6 THE GRAMMAR — one composer, every provider: exact strings, the
//       reset tail present exactly when the wire stated a reset.
//
//  Every feeder rides injected reads (hermetic — no fs, no network); the
//  poison control for this file is the Anthropic-only gate (an owner that
//  answers null off-anthropic reddens §2-§4).
//
//  Run: ~/.bun/bin/bun run scripts/usage-warning/prove-provider-limit-warning.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'usage-warning-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'HF_TOKEN',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' provider limit warning — every lane, its own signals, one grammar')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { providerLimitWarning, APPROACHING_LIMIT_PCT } = await import(
  '../../src/services/providers/limitWarning.ts'
)
const { rateLimitWindowName } = await import('../../src/services/rateLimitMessages.ts')
type Reads = NonNullable<Parameters<typeof providerLimitWarning>[0]>['reads']
type Limits = import('../../src/services/claudeAiLimits.ts').ClaudeAILimits

const HOUR = 3600
const nowS = Math.floor(Date.now() / 1000)
const resetS = nowS + 4 * HOUR

const spendZero = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const subEntry = {
  id: 'fx-sub',
  provider: 'anthropic',
  kind: 'oauth',
  label: 'fixture subscription',
  custodian: 'anthropic-slots',
} as const
const keyEntry = { ...subEntry, id: 'fx-key', kind: 'api-key' } as const

/** The base injected reads: spend zeroed, every account read absent unless
 *  a section overrides it. */
function baseReads(over: Partial<NonNullable<Reads>>): Reads {
  return {
    spend: () => ({ ...spendZero }),
    ...over,
  } as Reads
}

function anthroLimits(over: Partial<Limits>): Limits {
  return {
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
    ...over,
  } as Limits
}

//
section('§1 — anthropic: the existing meters, per-family claims included')
//
{
  const reads = (limits: Limits): Reads =>
    baseReads({
      route: () => 'anthropic',
      activeEntry: () => ({ ...subEntry }),
      anthropicWindows: () => ({
        fiveHour: { key: '5h', usedPct: null, resetsAtMs: null, state: 'unavailable' },
        sevenDay: { key: '7d', usedPct: null, resetsAtMs: null, state: 'unavailable' },
      }),
      anthropicPlan: () => 'max',
      anthropicLimits: () => limits,
    })

  const weekly = providerLimitWarning({
    model: 'claude-fable-5',
    reads: reads(
      anthroLimits({
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        utilization: 0.82,
        resetsAt: resetS,
      }),
    ),
  })
  check('weekly 82% fires', weekly !== null, JSON.stringify(weekly))
  check(
    '…in the ruled grammar with the reset tail',
    /^Anthropic: 82% of weekly limit used · resets .+$/.test(weekly?.text ?? ''),
    weekly?.text ?? '(null)',
  )

  const fable = providerLimitWarning({
    model: 'claude-fable-5',
    reads: reads(
      anthroLimits({
        status: 'allowed_warning',
        rateLimitType: 'seven_day_fable',
        utilization: 0.91,
        resetsAt: resetS,
      }),
    ),
  })
  check(
    'the FABLE bucket names itself (the sovereign meter reaches the strip)',
    /^Anthropic: 91% of Fable limit used · resets .+$/.test(fable?.text ?? ''),
    fable?.text ?? '(null)',
  )

  const below = providerLimitWarning({
    model: 'claude-fable-5',
    reads: reads(
      anthroLimits({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: resetS }),
    ),
  })
  check('below the 70% gate: silence (the existing mute)', below === null, JSON.stringify(below))

  const rejected = providerLimitWarning({
    model: 'claude-fable-5',
    reads: reads(anthroLimits({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetS })),
  })
  check('a REACHED limit is the error path, never this warning', rejected === null)

  const overageClose = providerLimitWarning({
    model: 'claude-fable-5',
    reads: reads(
      anthroLimits({
        status: 'rejected',
        isUsingOverage: true,
        overageStatus: 'allowed_warning',
        rateLimitType: 'five_hour',
      }),
    ),
  })
  check(
    'the overage-close warning keeps its stateful spelling (no percent exists)',
    overageClose?.text === 'Anthropic says this account is close to its extra usage spending limit',
    overageClose?.text ?? '(null)',
  )

  const keyed = providerLimitWarning({
    model: 'claude-fable-5',
    reads: baseReads({
      route: () => 'anthropic',
      activeEntry: () => ({ ...keyEntry }),
      anthropicLimits: () =>
        anthroLimits({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: resetS }),
    }),
  })
  check('an active anthropic API key has no subscription meters ⇒ no warning', keyed === null)

  check(
    'the sonnet window word rides the ONE spelling owner',
    rateLimitWindowName('seven_day_opus') === 'Opus limit' && rateLimitWindowName('seven_day_fable') === 'Fable limit',
  )

  // THE METER FEEDER: the 5h/7d window views (headers first, the
  // subscription usage endpoint filling absence) warn at the shared
  // threshold even when NO header status has arrived — a fresh sign-in's
  // /usage observation reaches the strip.
  const meterReads = (usedPct: number): Reads =>
    baseReads({
      route: () => 'anthropic',
      activeEntry: () => ({ ...subEntry }),
      anthropicWindows: () => ({
        fiveHour: { key: '5h', usedPct: null, resetsAtMs: null, state: 'unavailable' },
        sevenDay: { key: '7d', usedPct, resetsAtMs: resetS * 1000, state: 'live' },
      }),
      anthropicPlan: () => 'max',
      anthropicLimits: () => anthroLimits({}),
    })
  const meter = providerLimitWarning({ model: 'claude-fable-5', reads: meterReads(92) })
  check(
    'the endpoint-fed 7d METER at 92% warns with no header status (the wire vocabulary)',
    /^Anthropic: 92% of weekly limit used · resets .+$/.test(meter?.text ?? ''),
    meter?.text ?? '(null)',
  )
  const meterCalm = providerLimitWarning({ model: 'claude-fable-5', reads: meterReads(51) })
  check('…and below the threshold the meter feeder is silent', meterCalm === null)

  // THE POOL FEEDER: the per-model weekly pools the endpoint states (Fable ·
  // Opus · Sonnet) warn beside the shared windows, the WORST window named in
  // the wire's own claim vocabulary — the operator's frame: Fable at 99%
  // beside an all-models week at 51% paints the FABLE line (nothing else
  // crosses the threshold, so the base painted nothing at all).
  const poolReads = (fablePct: number): Reads =>
    baseReads({
      route: () => 'anthropic',
      activeEntry: () => ({ ...subEntry }),
      anthropicWindows: () => ({
        fiveHour: { key: '5h', usedPct: 23, resetsAtMs: resetS * 1000, state: 'live' },
        sevenDay: { key: '7d', usedPct: 51, resetsAtMs: resetS * 1000, state: 'live' },
      }),
      anthropicPoolWindows: () => [
        { key: 'seven_day_fable', label: 'Fable', state: 'live', usedPct: fablePct, resetsAtMs: resetS * 1000 },
        { key: 'seven_day_opus', label: 'Opus', state: 'live', usedPct: 12, resetsAtMs: resetS * 1000 },
      ],
      anthropicPlan: () => 'max',
      anthropicLimits: () => anthroLimits({}),
    })
  const pool = providerLimitWarning({ model: 'claude-fable-5', reads: poolReads(99) })
  check(
    "the endpoint-fed FABLE pool at 99% warns beside a calm 51% week (the operator's frame)",
    /^Anthropic: 99% of Fable limit used · resets .+$/.test(pool?.text ?? ''),
    pool?.text ?? '(null)',
  )
  const poolCalm = providerLimitWarning({ model: 'claude-fable-5', reads: poolReads(40) })
  check('…and a pool below the threshold stays silent', poolCalm === null, JSON.stringify(poolCalm))

  // THE RECORD ROAD (no injection): one endpoint observation folds the pools
  // into the ONE claudeAiLimits record, the LIVE pool view reads them, and
  // the warning reads them off the record — the strip's own road (the base
  // fold dropped every per-model bucket on the floor).
  const limitsMod = await import('../../src/services/claudeAiLimits.ts')
  const usageMod = await import('../../src/services/providers/providerUsage.ts')
  const isoReset = new Date(resetS * 1000).toISOString()
  limitsMod.foldUtilizationFromEndpoint({
    five_hour: { utilization: 23, resets_at: isoReset },
    seven_day: { utilization: 51, resets_at: isoReset },
    seven_day_fable: { utilization: 99, resets_at: isoReset },
    seven_day_opus: { utilization: 12, resets_at: isoReset },
  })
  const livePools = usageMod.anthropicPoolWindowViews()
  check(
    'the fold lands the per-model pools in the record (fable 99 · opus 12, live)',
    livePools.some(w => w.key === 'seven_day_fable' && w.state === 'live' && Math.round(w.usedPct ?? 0) === 99) &&
      livePools.some(w => w.key === 'seven_day_opus' && Math.round(w.usedPct ?? 0) === 12),
    JSON.stringify(livePools),
  )
  check('…and a pool the endpoint did not state is absent, never 0%', !livePools.some(w => w.key === 'seven_day_sonnet'))
  const fromRecord = providerLimitWarning({
    model: 'claude-fable-5',
    reads: baseReads({
      route: () => 'anthropic',
      activeEntry: () => ({ ...subEntry }),
      anthropicPlan: () => 'max',
      anthropicLimits: () => anthroLimits({}),
    }),
  })
  check(
    "the warning reads the pools off the record with no injection (the strip's own road)",
    /^Anthropic: 99% of Fable limit used · resets .+$/.test(fromRecord?.text ?? ''),
    fromRecord?.text ?? '(null)',
  )
  limitsMod.resetLimitsForCredentialSwitch()
  check('a credential switch empties the pools with the windows', usageMod.anthropicPoolWindowViews().length === 0)
}

//
section('§2 — openai: the observed x-codex bands feed the warning')
//
{
  const openaiReads = (usedPct: number): Reads =>
    baseReads({
      route: () => 'openai',
      activeEntry: () => ({ ...subEntry, provider: 'openai', kind: 'oauth', custodian: 'openai-accounts', identity: { plan: 'plus' } }),
      openaiObserved: () => ({
        primary: { usedPct: 12, windowMinutes: 300, observedAtMs: Date.now() },
        secondary: { usedPct, windowMinutes: 10080, resetsAtMs: resetS * 1000, observedAtMs: Date.now() },
      }),
      openaiLimited: () => ({ state: 'clear' }),
    })

  const wk = providerLimitWarning({ model: 'gpt-5.2', reads: openaiReads(78) })
  check('the weekly band at 78% fires as OpenAI', wk !== null, JSON.stringify(wk))
  check(
    '…in the ruled grammar (weekly window, reset tail)',
    /^OpenAI: 78% of weekly window used · resets .+$/.test(wk?.text ?? ''),
    wk?.text ?? '(null)',
  )
  const calm = providerLimitWarning({ model: 'gpt-5.2', reads: openaiReads(42) })
  check('every band below the threshold: silence', calm === null, JSON.stringify(calm))
}

//
section('§3 — openrouter: the credit cap approaches (the new tier)')
//
{
  const orReads = (usage: Record<string, unknown> | null): Reads =>
    baseReads({
      route: () => 'openrouter',
      openrouterKeyPresent: () => true,
      openrouterObserved: () => ({
        usage: usage as never,
      }),
      openrouterLimited: () => ({ state: 'clear' }),
    })

  const approaching = providerLimitWarning({
    model: 'openrouter/qwen/qwen3-coder',
    reads: orReads({ limit: 20, limitRemaining: 3.2, usage: 16.8, observedAtMs: Date.now() }),
  })
  check('the capped key at 84% fires as OpenRouter', approaching !== null, JSON.stringify(approaching))
  check(
    '…in the ruled grammar (credit cap; the /key wire states no reset instant ⇒ no tail)',
    approaching?.text === 'OpenRouter: 84% of credit cap used',
    approaching?.text ?? '(null)',
  )
  const uncapped = providerLimitWarning({
    model: 'openrouter/qwen/qwen3-coder',
    reads: orReads({ limit: null, limitRemaining: null, usage: 16.8, observedAtMs: Date.now() }),
  })
  check('an UNCAPPED key serves no percent ⇒ no warning (honest nothing)', uncapped === null)
  const unobserved = providerLimitWarning({
    model: 'openrouter/qwen/qwen3-coder',
    reads: orReads(null),
  })
  check('nothing observed yet ⇒ no warning (never a fabricated 0%)', unobserved === null)
}

//
section('§4 — kimi: the managed account’s stated windows warn as Kimi')
//
{
  const kimiReads: Reads = baseReads({
    route: () => 'moonshot',
    moonshotAccount: () => ({ kind: 'kimi-oauth' }),
    kimiManagedUsage: () => ({
      observedAtMs: Date.now(),
      windows: [
        { windowMinutes: 300, used: 88, limit: 100, resetsAtMs: resetS * 1000 },
        { windowMinutes: 10080, used: 10, limit: 100 },
      ],
    }),
  })
  const kimi = providerLimitWarning({ model: 'kimi-k2', reads: kimiReads })
  check('the 5h managed window at 88% fires as Kimi', kimi !== null, JSON.stringify(kimi))
  check(
    '…in the ruled grammar (5h window, reset tail)',
    /^Kimi: 88% of 5h window used · resets .+$/.test(kimi?.text ?? ''),
    kimi?.text ?? '(null)',
  )
}

//
section('§5 — honest nothing: a wire serving no percent signal warns never')
//
{
  const silent: Array<[string, string, Reads]> = [
    [
      'gemini (no usage endpoint — verified absence)',
      'gemini-2.5-pro',
      baseReads({ route: () => 'gemini', geminiAccount: () => ({ kind: 'oauth' } as never), geminiLimited: () => ({ state: 'clear' }) }),
    ],
    [
      'huggingface (no spend/credit API documented)',
      'huggingface/meta-llama/Llama-3.3-70B-Instruct',
      baseReads({ route: () => 'huggingface', huggingfaceAccount: () => ({ kind: 'oauth' } as never), huggingfaceLimited: () => ({ state: 'clear' }) }),
    ],
    [
      'local (no metering)',
      'local/llama3:8b',
      baseReads({ route: () => 'local', localAccount: () => ({ kind: 'keyless' } as never) }),
    ],
    ['zai (no usage wire)', 'glm-4.7', baseReads({ route: () => 'zai', zaiKeyPresent: () => true })],
    [
      'deepseek (balance only — no denominator)',
      'deepseek-chat',
      baseReads({
        route: () => 'deepseek',
        laneCredentialed: () => true,
        deepseekBalance: () => ({ observedAtMs: Date.now(), isAvailable: true, balances: [{ currency: 'USD', totalBalance: '1.02' }] }),
      }),
    ],
    [
      'compat (operator-named endpoint — nothing stated)',
      'compat/llama3:8b',
      baseReads({ route: () => 'openai-compat', laneCredentialed: () => true }),
    ],
    [
      'moonshot API key (balance only)',
      'kimi-k2',
      baseReads({
        route: () => 'moonshot',
        moonshotAccount: () => ({ kind: 'api-key' }),
        moonshotBalance: () => ({ observedAtMs: Date.now(), availableBalance: 3.5 }),
      }),
    ],
  ]
  for (const [label, model, reads] of silent) {
    check(`${label} ⇒ null`, providerLimitWarning({ model, reads }) === null)
  }
}

//
section('§6 — the law’s constants and the disconnected mute')
//
{
  check('the approaching threshold is the one 70% spelling', APPROACHING_LIMIT_PCT === 70)
  const none = providerLimitWarning({
    model: 'openrouter/qwen/qwen3-coder',
    reads: baseReads({ route: () => 'openrouter', openrouterKeyPresent: () => false }),
  })
  check('a disconnected lane warns never', none === null)
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(
  failures === 0
    ? '\n✅ prove-provider-limit-warning — all checks pass'
    : '\n❌ prove-provider-limit-warning — check(s) failed',
)
process.exit(failures)
