#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'compact-vitals-pool-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_MOCK_LIMITS = '1'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_USAGE_PAYLOAD']) delete process.env[name]
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' the compact VITALS line names the pool when the pool binds')
console.log('============================================================')

writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 7 * 24 * 3600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }),
)
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const limits = await import('../../src/services/anthropicLimits.ts')
const usage = await import('../../src/services/providers/providerUsage.ts')
const { buildLanesModel } = await import('../../src/utils/cockpit/helmLanesModel.ts')
const { fitRailName } = await import('../../src/components/HelmLanesRail.tsx')
const { displayWidth } = await import('../../src/components/mercury-ui/glyphs.ts')
const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
type SourceUsage = ReturnType<typeof usage.activeSourceUsage>

const OWNER = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000cv'
limits.__setAnthropicOwnerResolverForTest(() => OWNER, () => 'ana@example.com')
const FABLE = 'claude-fable-5-2'
const OPUS = 'claude-opus-5-5'
const RAIL_WIDTH = 24
const NAME_BUDGET = RAIL_WIDTH - 4
const nowSeconds = Math.floor(Date.now() / 1000)

function reply(fiveHour: number, sevenDay: number, pool: number | null): void {
  limits.resetLimitsForCredentialSwitch()
  limits.extractQuotaStatusFromHeaders(
    new Headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(fiveHour),
      'anthropic-ratelimit-unified-5h-reset': String(nowSeconds + 7800),
      'anthropic-ratelimit-unified-7d-utilization': String(sevenDay),
      'anthropic-ratelimit-unified-7d-reset': String(nowSeconds + 529200),
      ...(pool !== null ? { 'anthropic-ratelimit-unified-7d_oi-utilization': String(pool), 'anthropic-ratelimit-unified-7d_oi-reset': String(nowSeconds + 529200) } : {}),
    }),
    Date.now(),
  )
}
function lineOf(source: SourceUsage): string {
  const nowMs = Date.now()
  const model = buildLanesModel({
    width: RAIL_WIDTH,
    mergedVitals: true,
    availRows: 40,
    activity: 'calm',
    cursorRow: undefined,
    sessionCrew: [],
    viewingAgentTaskId: undefined,
    mainChatTaskId: undefined,
    tasks: {},
    roster: { rows: [] },
    workRunSnap: null,
    ledger: [],
    lastSentPrompt: null,
    filesOff: true,
    filesFolder: '',
    recent: null,
    missionCondition: null,
    wakeGlance: null,
    glance: {
      sessionModel: 'claude-fable-5-1',
      usage: source,
      focusedSpendUSD: 0,
      focusedUnpriced: 0,
      ctx: { usedPct: null, window: 1_000_000, compactAtPct: null, usedTokens: null, fillSource: null, windowSource: null, windowPinned: false },
      chip: { verdict: null, ageMs: null, ageLabel: 'never', stale: false },
      nowMs,
    },
    nowMs,
    tok: resolveMercuryTokens('dark', '#7dd3fc'),
    accent: '#7dd3fc',
  })
  const vitals = model.sections.find(s => s.key === 'vitals')
  const row = vitals?.rows.find(r => r.kind === 'rail' && r.key === 'tel:usage')
  return row !== undefined && row.kind === 'rail' ? row.name : `(no usage row; sections ${model.sections.map(s => s.key).join(',')})`
}
const live = (model: string): string => lineOf(usage.activeSourceUsage({ model }))
const painted = (name: string): string => fitRailName(name, NAME_BUDGET)

section('§1 a Fable session whose pool is the fullest window: the line is the pool')
{
  reply(0.36, 0.44, 0.61)
  const line = live(FABLE)
  check("the line reads 'Fable 61% · 6d · ↻…': the pool's label, its figure, its coarse reset, its age", /^Fable 61% · 6d · ↻\d+s$/.test(line), line)
  check('it takes the room the 5h line takes: twenty columns, painted whole in a 24-column rail', displayWidth(line) === 20 && painted(line) === line, `${displayWidth(line)} · ${painted(line)}`)
  check('the Mythos mirror reads the same pool', /^Fable 61% · 6d · /.test(live('claude-mythos-5-2')), live('claude-mythos-5-2'))
}

section('§2 every other case reads the line it read before')
{
  reply(0.36, 0.44, 0.61)
  check("an Opus session beside that pool: '5h 36% · 2h 9m · ↻…'", /^5h 36% · 2h 9m · ↻\d+s$/.test(live(OPUS)), live(OPUS))
  reply(0.8, 0.44, 0.61)
  check('a Fable session whose 5h window is fuller than its pool: the 5h line', /^5h 80% · 2h 9m · /.test(live(FABLE)), live(FABLE))
  reply(0.36, 0.7, 0.61)
  check('a Fable session whose 7d window is fuller than its pool: the 5h line, as before (the line never showed 7d)', /^5h 36% · 2h 9m · /.test(live(FABLE)), live(FABLE))
  reply(0.36, 0.61, 0.61)
  check('a pool level with the week does not take the line (the week binds a tie)', /^5h 36% · /.test(live(FABLE)), live(FABLE))
  reply(0.36, 0.44, null)
  check('a reply that states no pool: the 5h line', /^5h 36% · 2h 9m · /.test(live(FABLE)), live(FABLE))
  limits.resetLimitsForCredentialSwitch()
  check("nothing read yet: 'usage — after first reply'", live(FABLE) === 'usage — after first reply', live(FABLE))
}

section('§3 a source with no pools is untouched, and a long label cannot widen the rail')
{
  const stamp = { state: 'live' as const, source: 'headers' as const, observedAtMs: Date.now(), freshForMs: 120_000 }
  const wk = { key: 'wk', label: 'wk', usedPct: 72, resetsAtMs: Date.now() + 3 * 86_400_000 + 4 * 3_600_000, ...stamp }
  const fiveHours = { key: '5h', label: '5h', usedPct: 12, resetsAtMs: Date.now() + 2 * 3_600_000, ...stamp }
  const other = { provider: 'openai', sourceKind: 'subscription-oauth', label: 'OpenAI usage', shape: 'subscription-windows', windows: [fiveHours, wk], pools: [], spend: { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }, binding: { window: wk, windowName: 'weekly window' } } as unknown as SourceUsage
  check('an OpenAI subscription whose weekly band binds still reads its first window (5h 12% · 2h…)', /^5h 12% · (1h 59m|2h) · /.test(lineOf(other)), lineOf(other))
  const longPool = { key: 'seven_day_fable', label: 'Fable 5.2 and Mythos 5.2 research preview', usedPct: 61, resetsAtMs: Date.now() + 6 * 86_400_000, ...stamp }
  const wide = { ...other, provider: 'anthropic', label: 'Anthropic usage', pools: [longPool], binding: { window: longPool, claim: 'seven_day_fable', windowName: 'Fable limit' } } as unknown as SourceUsage
  const name = lineOf(wide)
  const fitted = painted(name)
  check("the rail's own fit ends a longer label in its ellipsis inside the row's twenty columns: one line, never wider", name.startsWith('Fable 5.2 and Mythos 5.2 research preview 61%') && fitted.endsWith('…') && displayWidth(fitted) <= NAME_BUDGET && !fitted.includes('\n'), `${fitted} (${displayWidth(fitted)})`)
  const owner = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
  check("in the product the pool's label is Mercury's own word (Fable, Opus, Sonnet), never the endpoint's free text", owner.includes("const POOL_LABELS: Record<WeeklyPoolClaim, string> = {\n  seven_day_fable: 'Fable',\n  seven_day_opus: 'Opus',\n  seven_day_sonnet: 'Sonnet',\n}") && owner.includes('label: POOL_LABELS[claim],'))
}

limits.__setAnthropicOwnerResolverForTest(null)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
