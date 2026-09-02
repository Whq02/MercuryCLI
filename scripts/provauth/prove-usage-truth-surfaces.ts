#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-usage-truth-surfaces.ts — LANE U (usage truth):
//  every usage surface derives one credential/usage answer per family.
//
//  The operator's frame: mid-GPT-session the telemetry rail's
//  USAGE box painted real OpenAI windows while the settings Usage tab said
//  "OpenAI usage: not connected" — two surfaces, two owners, one lie. The
//  laws under proof, over the REAL owners on a scratch home (no network —
//  every remote base pinned to a non-resolvable fixture host; the one local
//  probe hits a loopback fixture served by this prover):
//
//   §1 THE CONSISTENCY EQUATION, all ten families, both credential states:
//      providerFamilyPresences (the tab's section gate) ≡ activeSourceUsage
//      sourceKind (the rail/deck/frame read) ≡ resolveProviderUsability's
//      credential axis (the dispatch/limit path) — connected everywhere or
//      not-connected everywhere, never split; a signed-out lane carries the
//      owner's honest why-not, a signed-in lane carries none; sign-out
//      empties all surfaces together.
//   §2 THE OPERATOR'S FRAME CANNOT RECUR: the boot-time no-account record
//      is primed, the sign-in lands afterwards (the /logins timeline), the
//      account source states usage bands — and the tab gate, the rail
//      windows and the usability axis all read the signed-in truth in the
//      same instant. Then the sign-out mirror: windows empty with the gate.
//   §3 ONE WINDOW DECODE PER FAMILY: the tab and the rail read the SAME
//      view functions (source pins), and the anthropic endpoint fold lands
//      /api/oauth/usage observations in the claudeAiLimits record the rail
//      reads — scale round-trip proven, live headers win where present, a
//      credential switch empties both feeders.
//   §4 SIGNED-OUT HONESTY IN THE METER RENDERERS: the rail and the deck
//      paint the owner's why-not for a 'none' source — never the "fills
//      after first reply" promise a signed-out lane cannot keep.
//   §5 ONE ENDPOINT, ONE FOLD SEAM: every fetchUtilization observation
//      feeds the raw-window record (source pin).
//
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-usage-truth-surfaces.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
console.log(' PROVAUTH — usage truth: one answer behind every surface')
console.log('============================================================')

// ── hermetic ground: scratch home, every credential env cleared, every
//    remote base pinned (local-only probes; belt and suspenders) ────────────
const savedEnv: Record<string, string | undefined> = {}
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
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_LABEL',
  'MERCURY_COMPAT_MODELS',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_USAGE_SEED',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'ANTHROPIC_MODEL',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
const scratchHome = mkdtempSync(join(tmpdir(), 'prove-usage-truth-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
// The local lane's LIVE discovery probes the box's loopback ports — on an
// operator machine running Ollama/LM Studio the signed-out fixtures read a
// discovered server and every `local` expectation flips (found live:
// eight reds on a box with a server up, green in CI). The
// probe set pins to `none`: the suite is a fixture rig, never a discovery.
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
// Non-resolvable fixture bases for every family that has a pin (no probe in
// this prover performs network IO against them; the pins make a regression
// loud instead of live).
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://fixture.invalid/oauth'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'https://fixture.invalid/backend-api/codex'
process.env.MERCURY_OPENAI_API_BASE = 'https://fixture.invalid/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_ZAI_API_BASE = 'https://fixture.invalid/zai'

// Arm config reads BEFORE any real-owner path (the injected-doubles-mask
// lesson): the presence legs build the real router snapshot.
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const discovery = await import('../../src/utils/router/providerDiscovery.js')
const providerUsage = await import('../../src/services/providers/providerUsage.js')
const usageTab = await import('../../src/components/Settings/Usage.js')
const usability = await import('../../src/services/providers/providerUsability.js')
const openaiLimits = await import('../../src/services/providers/openai/openaiLimitState.js')
const claudeLimits = await import('../../src/services/claudeAiLimits.js')
const quota = await import('../../src/utils/cockpit/quota.js')
import type { RouterProviderId } from '../../src/utils/router/providers/types.js'

const ROOT = join(import.meta.dir, '..', '..')

/** One family's full surface answer, read from the LIVE owners. */
function surfaceFacts(family: RouterProviderId, model: string) {
  const presences = providerUsage.providerFamilyPresences()
  const row = presences.find(p => p.id === family)
  const plan = usageTab.usageSectionPlan(presences)
  const sectionRow = plan.find(s => s.id === family)
  // reads:{} bypasses the render-path TTL cache while keeping every read on
  // the live owners — the prover flips credentials faster than 2s.
  const asu = providerUsage.activeSourceUsage({ model, reads: {} })
  const use = usability.resolveProviderUsability()[family as keyof ReturnType<typeof usability.resolveProviderUsability>]
  return { row, sectionRow, asu, use }
}

interface FamilyLeg {
  family: RouterProviderId
  model: string
  /** Apply the family's own credential (env/file — the custodian's shape). */
  connect: () => void
  /** Remove it again. */
  disconnect: () => void
  /** A word the signed-out why-not must carry (the family's own connect home). */
  whyNotNames: string
}

const LEGS: FamilyLeg[] = [
  {
    family: 'anthropic',
    model: 'claude-sonnet-5',
    connect: () => void (process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture000'),
    disconnect: () => void delete process.env.ANTHROPIC_API_KEY,
    whyNotNames: '/logins',
  },
  {
    family: 'openai',
    model: 'gpt-5.6-sol',
    connect: () => void (process.env.OPENAI_API_KEY = 'sk-fixture000'),
    disconnect: () => void delete process.env.OPENAI_API_KEY,
    whyNotNames: '/logins',
  },
  {
    family: 'zai',
    model: 'glm-4.7',
    connect: () => void (process.env.ZAI_API_KEY = 'zai-fixture000'),
    disconnect: () => void delete process.env.ZAI_API_KEY,
    whyNotNames: '/logins zai',
  },
  {
    family: 'openrouter',
    model: 'openrouter/qwen/qwen3-coder',
    connect: () => void (process.env.OPENROUTER_API_KEY = 'sk-or-fixture000'),
    disconnect: () => void delete process.env.OPENROUTER_API_KEY,
    whyNotNames: '/logins',
  },
  {
    family: 'gemini',
    model: 'gemini-2.5-pro',
    connect: () => void (process.env.GEMINI_API_KEY = 'AIza-fixture000'),
    disconnect: () => void delete process.env.GEMINI_API_KEY,
    whyNotNames: '/logins',
  },
  {
    family: 'moonshot',
    model: 'kimi-k2-0905-preview',
    connect: () => void (process.env.MOONSHOT_API_KEY = 'sk-moonshot-fixture000'),
    disconnect: () => void delete process.env.MOONSHOT_API_KEY,
    whyNotNames: '/logins moonshot',
  },
  {
    family: 'deepseek',
    model: 'deepseek-chat',
    connect: () => void (process.env.DEEPSEEK_API_KEY = 'sk-deepseek-fixture000'),
    disconnect: () => void delete process.env.DEEPSEEK_API_KEY,
    whyNotNames: '/logins deepseek',
  },
  {
    family: 'openai-compat',
    model: 'compat/fixture-model',
    connect: () => void (process.env.MERCURY_COMPAT_BASE_URL = 'https://fixture.invalid/compat/v1'),
    disconnect: () => void delete process.env.MERCURY_COMPAT_BASE_URL,
    whyNotNames: 'MERCURY_COMPAT_BASE_URL',
  },
  {
    family: 'huggingface',
    model: 'huggingface/fixture/model',
    connect: () => void (process.env.HF_TOKEN = 'hf_fixture000'),
    disconnect: () => void delete process.env.HF_TOKEN,
    whyNotNames: '/logins',
  },
]

function assertState(
  name: string,
  facts: ReturnType<typeof surfaceFacts>,
  connected: boolean,
  whyNotNames: string,
): void {
  const { row, sectionRow, asu, use } = facts
  check(`${name}: family row exists in the presence enumeration`, row !== undefined)
  check(`${name}: a /usage section mounts for the family`, sectionRow !== undefined)
  if (!row || !sectionRow) return
  // The equation: tab gate ≡ rail/deck source ≡ usability credential axis.
  check(
    `${name}: tab gate (presences.credentialed) reads ${connected}`,
    row.credentialed === connected,
    `credentialed=${row.credentialed}`,
  )
  check(
    `${name}: rail/deck source (activeSourceUsage) agrees`,
    (asu.sourceKind !== 'none') === connected,
    `sourceKind=${asu.sourceKind}`,
  )
  check(
    `${name}: usability credential axis agrees`,
    (use.credential !== 'none') === connected,
    `credential=${use.credential}`,
  )
  if (connected) {
    check(`${name}: a connected lane carries NO why-not`, asu.whyNot === undefined, `whyNot=${asu.whyNot}`)
  } else {
    check(
      `${name}: the signed-out why-not names the family's connect home`,
      typeof asu.whyNot === 'string' && asu.whyNot.includes(whyNotNames),
      `whyNot=${asu.whyNot}`,
    )
    check(`${name}: a signed-out lane renders NO windows`, asu.windows.length === 0)
  }
}

section('§1 the consistency equation — ten families × {signed-out, signed-in, signed-out}')
for (const leg of LEGS) {
  leg.disconnect()
  discovery.__resetProviderDiscoveryForTest()
  assertState(`${leg.family} pre`, surfaceFacts(leg.family, leg.model), false, leg.whyNotNames)
  leg.connect()
  discovery.__resetProviderDiscoveryForTest()
  assertState(`${leg.family} in`, surfaceFacts(leg.family, leg.model), true, leg.whyNotNames)
  leg.disconnect()
  discovery.__resetProviderDiscoveryForTest()
  assertState(`${leg.family} out`, surfaceFacts(leg.family, leg.model), false, leg.whyNotNames)
}

// local — the one probing family: a loopback fixture serves the Ollama
// discovery shape; the base pin scopes the probe to this prover's server.
{
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/version') return Response.json({ version: '0.0-fixture' })
      if (path === '/api/tags') return Response.json({ models: [{ name: 'fixture-llama' }] })
      return new Response('not found', { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  discovery.__resetProviderDiscoveryForTest()
  await discovery.refreshProviderDiscovery('local', { force: true })
  assertState('local pre', surfaceFacts('local', 'local/fixture-llama'), false, 'local server')
  process.env.MERCURY_LOCAL_BASE_URL = base
  discovery.__resetProviderDiscoveryForTest()
  await discovery.refreshProviderDiscovery('local', { force: true })
  assertState('local in', surfaceFacts('local', 'local/fixture-llama'), true, 'local server')
  delete process.env.MERCURY_LOCAL_BASE_URL
  discovery.__resetProviderDiscoveryForTest()
  await discovery.refreshProviderDiscovery('local', { force: true })
  assertState('local out', surfaceFacts('local', 'local/fixture-llama'), false, 'local server')
  server.stop(true)
}

section('§2 the operator frame cannot recur — sign-in lands after the boot prime; bands observed')
{
  // 1. Boot state: no OpenAI credential anywhere; prime the discovery the
  //    way a boot does (the stale record that caused the frame).
  discovery.__resetProviderDiscoveryForTest()
  openaiLimits.__resetOpenaiLimitStateForTest()
  const boot = surfaceFacts('openai', 'gpt-5.6-sol')
  check('frame: boot state reads not-connected everywhere', boot.row?.credentialed === false && boot.asu.sourceKind === 'none')

  // 2. The /logins outcome: the subscription token store appears AFTER the
  //    prime (no discovery reset here — the fix must not need one).
  writeFileSync(
    join(scratchHome, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }),
  )
  // 3. The account source states usage bands (the x-codex header family on
  //    a response — the rail's windows).
  openaiLimits.recordOpenaiRateHeaders(
    new Headers({
      'x-codex-primary-used-percent': '0',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '601140',
    }),
    () => 1_756_000_000_000,
  )

  const after = surfaceFacts('openai', 'gpt-5.6-sol')
  check(
    'frame: the tab gate reads the sign-in with NO discovery reset (the stale-cache class is dead)',
    after.row?.credentialed === true,
    `credentialed=${after.row?.credentialed}`,
  )
  check('frame: the rail source is the subscription lane', after.asu.sourceKind === 'subscription-oauth')
  check(
    'frame: the rail renders the observed weekly band',
    after.asu.windows.some(w => w.key === 'wk' && w.usedPct === 0),
    `windows=${JSON.stringify(after.asu.windows)}`,
  )
  check(
    'frame: the tab reads the SAME bands through the same view fn',
    JSON.stringify(providerUsage.openaiObservedWindowViews()) === JSON.stringify(after.asu.windows),
  )
  check(
    'frame: the INVARIANT — no surface says not-connected while windows render',
    after.row?.credentialed === true && after.use.credential !== 'none' && after.asu.windows.length > 0,
  )
  check('frame: the tier fact names the ChatGPT plan', after.asu.tier === 'ChatGPT Plus', `tier=${after.asu.tier}`)

  // 4. The sign-out mirror: the store empties every surface together even
  //    though the limit module still holds its last observation.
  rmSync(join(scratchHome, '.openai-auth.json'))
  const out = surfaceFacts('openai', 'gpt-5.6-sol')
  check('frame: sign-out empties the tab gate', out.row?.credentialed === false)
  check('frame: sign-out empties the rail windows', out.asu.sourceKind === 'none' && out.asu.windows.length === 0)
  check('frame: sign-out restores the honest why-not', typeof out.asu.whyNot === 'string')
  openaiLimits.__resetOpenaiLimitStateForTest()
}

section('§3 one window decode per family — shared view fns + the anthropic endpoint fold')
{
  // The tab's meter reads are the owner's exported view fns (source pins).
  const tabSource = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('tab: anthropic meters read anthropicWindowViews (the owner view)', tabSource.includes('anthropicWindowViews()'))
  check('tab: openai meters read openaiObservedWindowViews (the owner view)', tabSource.includes('openaiObservedWindowViews()'))
  check('tab: kimi meters read the owner view (usageForProvider — its windows ARE kimiManagedWindowViews)', tabSource.includes("useOwnerUsage('moonshot'") && tabSource.includes('const windows = usage.windows'))
  check(
    'tab: no direct data.five_hour/seven_day meter render survives (one decode)',
    !/data\.five_hour\s*!=\s*null\s*\?\s*\(\s*<Meter/.test(tabSource) && !/data\.seven_day\s*!=\s*null\s*\?\s*\(\s*<Meter/.test(tabSource),
  )

  // The endpoint fold: scale round-trip (0–100 ⇄ fraction; ISO ⇄ epoch s).
  const resetIso = new Date(1_756_000_000_000 + 3_600_000).toISOString()
  claudeLimits.foldUtilizationFromEndpoint({
    five_hour: { utilization: 37, resets_at: resetIso },
    seven_day: { utilization: 62, resets_at: resetIso },
  })
  const windows = quota.quotaWindows()
  check('fold: 5h round-trips to 37%', windows.fiveHour.state === 'live' && windows.fiveHour.usedPct === 37, JSON.stringify(windows.fiveHour))
  check('fold: 7d round-trips to 62%', windows.sevenDay.state === 'live' && windows.sevenDay.usedPct === 62)
  check('fold: resets round-trip to the ISO instant (ms)', windows.fiveHour.resetsAtMs === Date.parse(resetIso))
  const anthView = providerUsage.anthropicWindowViews()
  check(
    'fold: the owner view (rail read) serves the folded windows',
    anthView.some(w => w.key === '5h' && w.usedPct === 37) && anthView.some(w => w.key === '7d' && w.usedPct === 62),
  )

  // Live headers WIN where present; the endpoint keeps filling the gaps.
  // (The live header writer sits behind the subscriber/mock gate — the
  //  proof seam places the header record; the precedence is the overlay's.)
  claudeLimits.__setRawUtilizationForTest({
    five_hour: { utilization: 0.5, resets_at: Math.floor(Date.parse(resetIso) / 1000) },
  })
  const merged = quota.quotaWindows()
  check('fold: a live header wins its window (5h=50%)', merged.fiveHour.usedPct === 50, `got ${merged.fiveHour.usedPct}`)
  check('fold: the endpoint still fills the absent window (7d=62%)', merged.sevenDay.usedPct === 62, `got ${merged.sevenDay.usedPct}`)

  // The endpoint observation beats the render seed (read-time overlay order:
  // live > endpoint > seed — the seed fills only what both left absent).
  process.env.MERCURY_USAGE_SEED = '7d=90'
  const withSeed = quota.quotaWindows()
  check('fold: the endpoint observation beats the render seed (7d stays 62%)', withSeed.sevenDay.usedPct === 62, `got ${withSeed.sevenDay.usedPct}`)
  delete process.env.MERCURY_USAGE_SEED

  // Partial/garbage endpoint facts stay absent — never a fabricated window.
  claudeLimits.__setRawUtilizationForTest({})
  claudeLimits.foldUtilizationFromEndpoint({
    five_hour: { utilization: null, resets_at: resetIso },
    seven_day: { utilization: Number.NaN, resets_at: resetIso },
  })
  const cleared = quota.quotaWindows()
  check('fold: an unusable observation clears its endpoint record (nothing fabricated)', cleared.sevenDay.state === 'unavailable' && cleared.fiveHour.state === 'unavailable')

  // A credential switch empties BOTH feeders.
  claudeLimits.foldUtilizationFromEndpoint({ five_hour: { utilization: 12, resets_at: resetIso } })
  claudeLimits.resetLimitsForCredentialSwitch()
  const afterSwitch = quota.quotaWindows()
  check(
    'fold: a credential switch empties header AND endpoint records',
    afterSwitch.fiveHour.state === 'unavailable' && afterSwitch.sevenDay.state === 'unavailable',
  )

  // The C8 gate close empties both feeders too — through the REAL header
  // path: this prover's env is no subscriber and no mock, so the live call
  // must settle every window feeder to the honest default.
  claudeLimits.foldUtilizationFromEndpoint({ five_hour: { utilization: 44, resets_at: resetIso } })
  claudeLimits.extractQuotaStatusFromHeaders(new Headers({}))
  const afterGate = quota.quotaWindows()
  check(
    'fold: a closed subscriber gate empties the endpoint record with the header record (C8)',
    afterGate.fiveHour.state === 'unavailable',
  )
}

section('§4 signed-out honesty in the meter renderers (source pins)')
{
  const rail = readFileSync(join(ROOT, 'src/components/HelmTelemetryRail.tsx'), 'utf8')
  const deck = readFileSync(join(ROOT, 'src/components/Deck.tsx'), 'utf8')
  check('rail: renders the owner why-not for a none source', rail.includes('usage.whyNot'))
  check(
    "rail: the none branch is adjudicated BEFORE the fills-after hint",
    rail.indexOf("usage.sourceKind === 'none'") !== -1 &&
      rail.indexOf("usage.sourceKind === 'none'") < rail.indexOf('fills after first reply'),
  )
  check('deck: renders the owner why-not for a none source', deck.includes('usage.whyNot'))
  check('deck: no hardcoded not-logged-in line survives', !deck.includes('not logged in — /logins connects'))
}

section('§5 one endpoint, one fold seam (fetchUtilization feeds the window store)')
{
  const apiSource = readFileSync(join(ROOT, 'src/services/api/usage.ts'), 'utf8')
  check('seam: fetchUtilization folds the raw windows', apiSource.includes('foldUtilizationFromEndpoint('))
}

// ── restore ─────────────────────────────────────────────────────────────────
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('')
if (failures > 0) {
  console.log(`❌ prove-usage-truth-surfaces: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-usage-truth-surfaces: every surface derives the one answer')
