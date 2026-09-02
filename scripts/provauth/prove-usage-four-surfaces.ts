#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' PROVAUTH — usage truth: rail ≡ tab ≡ limits ≡ coordinator')
console.log('============================================================')

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_USAGE_SEED',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
const home = mkdtempSync(join(tmpdir(), 'authhard-usage-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_AUTH_SCOPE_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const limits = await import('../../src/services/claudeAiLimits.js')
const usage = await import('../../src/services/providers/providerUsage.js')
const { providerLimitWarning, preferSessionLimitWarning, APPROACHING_LIMIT_PCT } = await import(
  '../../src/services/providers/limitWarning.js'
)
type UsageReads = NonNullable<NonNullable<Parameters<typeof usage.activeSourceUsage>[0]>['reads']>

const ZERO_SPEND = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const NOW = Date.now()
const RESET_EPOCH = Math.floor(NOW / 1000) + 3600

section('§1 anthropic: headers + endpoint + pools — precedence, equality, the claim-vocabulary warning')
{
  limits.__setRawUtilizationForTest({ seven_day: { utilization: 0.93, resets_at: RESET_EPOCH } })
  limits.foldUtilizationFromEndpoint(
    {
      five_hour: { utilization: 50, resets_at: new Date((RESET_EPOCH - 1800) * 1000).toISOString() },
      seven_day: { utilization: 80, resets_at: new Date(RESET_EPOCH * 1000).toISOString() },
      seven_day_fable: { utilization: 99, resets_at: new Date(RESET_EPOCH * 1000).toISOString() },
    },
    limits.getUsageCredentialEpoch(),
  )
  const raw = limits.getRawUtilization()
  check(
    'precedence: headers win per window (7d = 93%), the endpoint fills absence (5h = 50%), the pool rides endpoint-only',
    raw.seven_day?.utilization === 0.93 &&
      raw.five_hour?.utilization === 0.5 &&
      raw.seven_day_fable?.utilization === 0.99,
    JSON.stringify(raw),
  )

  const reads: UsageReads = {
    route: () => 'anthropic' as never,
    activeEntry: () => ({ provider: 'anthropic', kind: 'oauth' }) as never,
    anthropicPlan: () => 'max',
    spend: () => ZERO_SPEND,
  }
  const rail = usage.activeSourceUsage({ model: 'claude-fable-5', reads })
  const tab = usage.anthropicWindowViews()
  check(
    'rail ≡ tab: the subscription windows are BYTE-equal between the card and the view owner',
    JSON.stringify(rail.windows) === JSON.stringify(tab) && rail.shape === 'subscription-windows',
    JSON.stringify({ rail: rail.windows, tab }),
  )
  check(
    "the tier speaks the custodian's plan ('Claude Max') and the pools ride the shared record",
    rail.tier === 'Claude Max' &&
      JSON.stringify(usage.anthropicPoolWindowViews().map(v => `${v.label}=${v.usedPct}`)) ===
        JSON.stringify(['Fable=99']),
  )

  const warning = providerLimitWarning({ model: 'claude-fable-5', reads })
  check(
    "limits ≡ meters: the strip warning names the WORST window in the wire's claim vocabulary (Fable, 99%)",
    warning !== null && warning.text.startsWith('Anthropic: 99% of Fable limit used'),
    warning?.text,
  )

  limits.__setRawUtilizationForTest({})
  limits.foldUtilizationFromEndpoint(
    { five_hour: { utilization: 10, resets_at: new Date(RESET_EPOCH * 1000).toISOString() } },
    limits.getUsageCredentialEpoch(),
  )
  const refolded = limits.getRawUtilization()
  check(
    'latching: each endpoint observation replaces the endpoint record WHOLE — dropped windows leave',
    refolded.five_hour?.utilization === 0.1 &&
      refolded.seven_day === undefined &&
      refolded.seven_day_fable === undefined,
    JSON.stringify(refolded),
  )
  limits.resetLimitsForCredentialSwitch()
  limits.foldUtilizationFromEndpoint(
    { five_hour: { utilization: 77, resets_at: new Date(RESET_EPOCH * 1000).toISOString() } },
    limits.getUsageCredentialEpoch() - 1,
  )
  check(
    'latching: an observation issued under a departed credential epoch folds NOWHERE',
    limits.getRawUtilization().five_hour === undefined,
  )
}

section('§2 openrouter: the credit cap — equality, the warning, the typed facts')
{
  const observed = {
    usage: {
      observedAtMs: NOW,
      limit: 10,
      limitRemaining: 2.5,
    } as never,
  }
  const reads: UsageReads = {
    route: () => 'openrouter' as never,
    openrouterKeyPresent: () => true,
    openrouterObserved: () => observed as never,
    openrouterLimited: () => ({ state: 'clear' }) as never,
    spend: () => ZERO_SPEND,
  }
  const rail = usage.activeSourceUsage({ model: 'openrouter-fixture', reads })
  const tab = usage.openrouterObservedWindowViews(reads)
  check(
    'rail ≡ tab: the cap window is BYTE-equal and states 75% used',
    JSON.stringify(rail.windows) === JSON.stringify(tab) &&
      tab.length === 1 &&
      tab[0]!.key === 'cap' &&
      tab[0]!.usedPct === 75,
    JSON.stringify({ rail: rail.windows, tab }),
  )
  check(
    'the typed credit facts hand the tab the SAME observation object',
    usage.openrouterCreditFacts(reads).usage === (observed.usage as never),
  )
  const warning = providerLimitWarning({ model: 'openrouter-fixture', reads })
  check(
    'limits ≡ meters: the warning speaks the credit cap at 75%',
    warning !== null && warning.text.startsWith('OpenRouter: 75% of credit cap used'),
    warning?.text,
  )
}

section('§3 the Kimi sign-in: managed windows — equality, the warning')
{
  const managed = {
    observedAtMs: NOW,
    quota: { used: 1, limit: 100 },
    windows: [{ windowMinutes: 300, used: 9, limit: 10, resetsAtMs: NOW + 1800_000 }],
  }
  const reads: UsageReads = {
    route: () => 'moonshot' as never,
    moonshotAccount: () => ({ kind: 'kimi-oauth' }) as never,
    kimiManagedUsage: () => managed as never,
    spend: () => ZERO_SPEND,
  }
  const rail = usage.activeSourceUsage({ model: 'kimi-fixture', reads })
  const tab = usage.kimiManagedWindowViews(managed as never)
  check(
    'rail ≡ tab: the managed windows are BYTE-equal (rate window first, quota last)',
    JSON.stringify(rail.windows) === JSON.stringify(tab) &&
      tab.map(v => v.label).join('|') === '5h|quota' &&
      rail.tier === 'Kimi sign-in',
    JSON.stringify({ rail: rail.windows, tab }),
  )
  const warning = providerLimitWarning({ model: 'kimi-fixture', reads })
  check(
    'limits ≡ meters: the warning names the stated window at 90% (Kimi voice)',
    warning !== null && warning.text.startsWith('Kimi: 90% of 5h window used'),
    warning?.text,
  )
}

section('§4 openai subscription: observed bands — equality, the warning')
{
  const observed = {
    primary: { usedPct: 82, windowMinutes: 300, resetsAtMs: NOW + 600_000, observedAtMs: NOW },
    secondary: { usedPct: 41, windowMinutes: 10_080, observedAtMs: NOW },
  }
  const reads: UsageReads = {
    route: () => 'openai' as never,
    activeEntry: () => ({ provider: 'openai', kind: 'oauth', identity: { plan: 'plus' } }) as never,
    openaiObserved: () => observed as never,
    openaiLimited: () => ({ state: 'clear' }) as never,
    spend: () => ZERO_SPEND,
  }
  const rail = usage.activeSourceUsage({ model: 'gpt-fixture', reads })
  const tab = usage.openaiObservedWindowViews(reads)
  check(
    'rail ≡ tab: the observed bands are BYTE-equal, shorter window first, tier from the custodian',
    JSON.stringify(rail.windows) === JSON.stringify(tab) &&
      tab.map(v => v.label).join('|') === '5h|wk' &&
      rail.tier === 'ChatGPT Plus',
    JSON.stringify({ rail: rail.windows, tab, tier: rail.tier }),
  )
  const warning = providerLimitWarning({ model: 'gpt-fixture', reads })
  check(
    'limits ≡ meters: the warning names the worst band (82% of 5h window, OpenAI voice)',
    warning !== null && warning.text.startsWith('OpenAI: 82% of 5h window used'),
    warning?.text,
  )
}

section('§5 the coordinator fold: the runner fact wins; null/absent fall through; one producer')
{
  const fromRunner = { provider: 'openai', text: 'OpenAI: 82% of 5h window used' }
  const local = { provider: 'anthropic', text: 'Anthropic: 71% of session limit used' }
  check(
    "the runner's observation wins; a null runner (sees no warning) and an absent one fall to the local derivation",
    preferSessionLimitWarning(fromRunner, local) === fromRunner &&
      preferSessionLimitWarning(null, local) === local &&
      preferSessionLimitWarning(undefined, local) === local &&
      preferSessionLimitWarning(null, null) === null,
  )
  const printSrc = readFileSync(join(import.meta.dir, '..', '..', 'src/cli/print.ts'), 'utf8')
  check(
    'the session-facts producer rides providerLimitWarning (one owner, pinned at the source)',
    printSrc.includes('limitWarning: providerLimitWarning({ model:'),
  )
}

section('§6 vocabulary honesty: no borrowed family words on any lane')
{
  const lanes: Array<{ family: string; reads: UsageReads; forbidden: RegExp }> = [
    {
      family: 'zai',
      reads: { route: () => 'zai' as never, zaiKeyPresent: () => true, spend: () => ZERO_SPEND },
      forbidden: /Claude|Anthropic|ChatGPT|Gemini|Kimi/,
    },
    {
      family: 'deepseek',
      reads: {
        route: () => 'deepseek' as never,
        laneCredentialed: () => true,
        deepseekBalance: () => null,
        spend: () => ZERO_SPEND,
      },
      forbidden: /Claude|Anthropic|ChatGPT|Gemini|Kimi/,
    },
    {
      family: 'gemini',
      reads: {
        route: () => 'gemini' as never,
        geminiAccount: () => ({ kind: 'oauth' }) as never,
        geminiLimited: () => ({ state: 'clear' }) as never,
        spend: () => ZERO_SPEND,
      },
      forbidden: /Claude|Anthropic|ChatGPT|Kimi/,
    },
    {
      family: 'local',
      reads: { route: () => 'local' as never, localAccount: () => ({ kind: 'keyless', label: 'ollama' }) as never, spend: () => ZERO_SPEND },
      forbidden: /Claude|Anthropic|ChatGPT|Gemini|Kimi/,
    },
  ]
  for (const lane of lanes) {
    const view = usage.activeSourceUsage({ model: `${lane.family}-fixture`, reads: lane.reads })
    const spoken = `${view.label} · ${view.tier ?? ''} · ${view.absence ?? ''} · ${view.whyNot ?? ''}`
    check(
      `${lane.family}: the view borrows no other family's words`,
      !lane.forbidden.test(spoken),
      spoken,
    )
  }
  const keyLane = usage.activeSourceUsage({
    model: 'zai-fixture',
    reads: { route: () => 'zai' as never, zaiKeyPresent: () => true, spend: () => ZERO_SPEND },
  })
  check("the api-key tier is the one spelling ('API billing')", keyLane.tier === 'API billing')
}

section('§7 scheduled spend: Saturn fires replay session envelopes — the one ledger counts them')
{
  const ticker = readFileSync(join(import.meta.dir, '..', '..', 'src/daemon/saturnTicker.ts'), 'utf8')
  check(
    'the fire road is the envelope replay (no model dispatch in the ticker)',
    ticker.includes('replayEnvelope(') && !ticker.includes('queryModelWithStreaming'),
  )
  const spend = usage.providerSessionSpend('anthropic' as never)
  check(
    'the spend partition answers the one ledger shape (zero on a fresh scratch home)',
    spend.inputTokens === 0 && spend.outputTokens === 0 && spend.costUSD === 0 && spend.models === 0,
  )
}

section('§8 the REAL cache: equality holds THROUGH the live 2s activeUsageCache, and the model key invalidates')
{
  const { writeFileSync } = await import('node:fs')
  const { clearOAuthTokenCache } = await import('../../src/utils/auth.js')
  writeFileSync(
    join(process.env.MERCURY_AUTH_SCOPE_DIR!, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-EXPIRED-fixture',
        refreshToken: 'sk-ant-ort01-fixture',
        expiresAt: Date.now() - 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    }),
    { mode: 0o600 },
  )
  clearOAuthTokenCache()
  limits.__setRawUtilizationForTest({
    seven_day: { utilization: 0.93, resets_at: Math.floor(Date.now() / 1000) + 3600 },
  })
  const MODEL = 'claude-fable-5'
  const first = usage.activeSourceUsage({ model: MODEL })
  const second = usage.activeSourceUsage({ model: MODEL })
  check(
    'same-instant no-reads reads share ONE cached value (all four surfaces see one truth through the REAL cache)',
    first === second && first.shape === 'subscription-windows',
    `shape=${first.shape} sameRef=${first === second}`,
  )
  const other = usage.activeSourceUsage({ model: 'gpt-5.2' })
  const back = usage.activeSourceUsage({ model: MODEL })
  check(
    'the model key invalidates immediately: a different model never serves the cached value; switching back re-derives',
    other !== first && back !== first,
    `otherShape=${other.shape}`,
  )
  const beforeSwitch = usage.activeSourceUsage({ model: MODEL })
  limits.resetLimitsForCredentialSwitch()
  const afterSwitch = usage.activeSourceUsage({ model: MODEL })
  check(
    'a credential switch inside the TTL re-derives immediately (the epoch guard — never the departed account\'s meters)',
    afterSwitch !== beforeSwitch,
    `sameRef=${afterSwitch === beforeSwitch}`,
  )
  limits.__setRawUtilizationForTest({})
  limits.resetLimitsForCredentialSwitch()
  clearOAuthTokenCache()
}

console.log(
  failures === 0 ? '\nALL GREEN (usage four surfaces)' : `\n${failures} FAILURES`,
)
process.exit(failures === 0 ? 0 : 1)
