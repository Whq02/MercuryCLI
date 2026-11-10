#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'fable-pool-wire-'))
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const show = (v: unknown): string => JSON.stringify(v)

console.log('============================================================')
console.log(' the Fable weekly pool is read where the provider states it')
console.log('============================================================')

writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 7 * 24 * 3600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }),
)
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const limits = await import('../../src/services/anthropicLimits.ts')
const usage = await import('../../src/services/providers/providerUsage.ts')
const { fetchUtilization } = await import('../../src/services/api/usage.ts')
const { buildVitalsModel } = await import('../../src/utils/cockpit/helmVitalsModel.ts')
const { healthCertSnapshot } = await import('../../src/utils/cockpit/healthCertSnapshot.ts')
const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')

const OWNER = 'anthropic:oauth:primary:00000000-0000-4000-8000-0000000000fb'
limits.__setAnthropicOwnerResolverForTest(() => OWNER, () => 'ana@example.com')
const FABLE = 'claude-fable-5-2'
const NOW = Date.now()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (ms: number): string => new Date(ms).toISOString()

type LimitRow = { kind: string; group: string; percent: number; severity?: string; resets_at: string | null; scope: { model: { id: null; display_name: string } | null; surface: unknown } | null; is_active?: boolean }
type Body = Record<string, unknown> & { limits: LimitRow[] }
const recorded = JSON.parse(readFileSync(join(ROOT, 'scripts/providers/fixtures/anthropic-oauth-usage.json'), 'utf8')) as { observed: string; body: Body }
const MASKED_NAME = '<masked string, 5 chars>'

function liveBody(over: (body: Body) => void = () => {}): Body {
  const body = JSON.parse(JSON.stringify(recorded.body)) as Body
  ;(body.five_hour as { resets_at: string }).resets_at = iso(NOW + 2 * HOUR)
  ;(body.seven_day as { resets_at: string }).resets_at = iso(NOW + 6 * DAY)
  for (const row of body.limits) {
    row.resets_at = iso(NOW + (row.kind === 'session' ? 2 * HOUR : 6 * DAY))
    if (row.scope?.model?.display_name === MASKED_NAME) row.scope.model.display_name = 'Fable'
  }
  over(body)
  return body
}
async function readEndpoint(body: Record<string, unknown>): Promise<void> {
  limits.resetLimitsForCredentialSwitch()
  process.env.MERCURY_MOCK_USAGE_PAYLOAD = JSON.stringify(body)
  await fetchUtilization()
}
const poolsNow = (): string => usage.anthropicPoolWindowViews().map(p => `${p.key}:${p.label}:${Math.round(p.usedPct ?? -1)}:${p.source}`).join(' · ')
function railMeters(): string[] {
  const view = usage.usageForProvider('anthropic')
  const model = buildVitalsModel({
    width: 32,
    availRows: 44,
    termRows: 50,
    sessionModel: FABLE,
    usage: view,
    otherUsages: [],
    workRoster: { rows: [], mission: [] },
    focusedSessionId: null,
    runningWf: [],
    externalWf: [],
    ctx: { usedPct: null, window: 0, compactAtPct: null, usedTokens: null, fillSource: null, windowSource: null, windowPinned: false },
    ctxTurns: null,
    ctxGrowth: [],
    activity: { pulses: 0, perBin: [] },
    cert: healthCertSnapshot(),
    now: NOW,
    readNow: NOW,
    tok: resolveMercuryTokens('dark', '#7dd3fc'),
  })
  const rows = model.sections.find(s => s.key === 'usage')?.rows ?? []
  return rows.flatMap(r => (r.kind === 'meter' ? [`${r.window} ${Math.round(r.value ?? -1)}%${r.resetIn !== undefined ? ` ${r.resetIn}` : ''}`] : []))
}

section(`§1 the recorded reply of the usage endpoint (scripts/providers/fixtures/anthropic-oauth-usage.json, observed ${recorded.observed}): where the pool stands`)
{
  const scoped = recorded.body.limits.filter(r => r.kind === 'weekly_scoped')
  check('the reply carries no seven_day_fable key at all', !('seven_day_fable' in recorded.body), Object.keys(recorded.body).join(','))
  check('the per-model week is one limits[] row: kind weekly_scoped, group weekly, a percent, a reset and scope.model.display_name', scoped.length === 1 && scoped[0]!.group === 'weekly' && scoped[0]!.percent === 42 && typeof scoped[0]!.resets_at === 'string' && typeof scoped[0]!.scope?.model?.display_name === 'string', show(scoped))
  check("the capture masks the name (five characters); the provider's published client lists 'Fable' first among the names it paints (npm @anthropic-ai/claude-code-darwin-arm64 2.1.321, read 2026-11-09 — its code, not a documented API)", scoped[0]!.scope?.model?.display_name === MASKED_NAME && 'Fable'.length === 5)
  check('the session and all-models rows are limits[] rows too, beside the five_hour and seven_day objects', recorded.body.limits.map(r => r.kind).join(',') === 'session,weekly_all,weekly_scoped' && typeof recorded.body.five_hour === 'object' && typeof recorded.body.seven_day === 'object')
}

section('§2 the reader: that reply, read through the usage seam, paints the Fable week')
{
  await readEndpoint(liveBody())
  check('the pool view exists once: Fable at 42%, fed by the endpoint, with the row\'s reset', poolsNow() === 'seven_day_fable:Fable:42:endpoint' && usage.anthropicPoolWindowViews()[0]?.resetsAtMs === Date.parse(iso(NOW + 6 * DAY)), poolsNow())
  const meters = railMeters()
  check('the USAGE rail paints 5h, 7d and Fable, in that order, with the idiom of a pool row (bar, percent, coarse reset)', meters.length === 3 && meters[0]!.startsWith('5h 20%') && meters[1]!.startsWith('7d 22%') && /^Fable 42% (5d|6d)/.test(meters[2]!), show(meters))
  check('the figures line /usage prints names it too', /Fable 42% · resets /.test(usage.usageSummaryWords(usage.usageForProvider('anthropic'), NOW)), usage.usageSummaryWords(usage.usageForProvider('anthropic'), NOW))
  check("the window that binds a Fable session is that pool when it is the fullest (the warning strip's own source)", usage.bindingWindowFor(FABLE)?.window.key === 'seven_day_fable' && usage.bindingWindowFor(FABLE)?.windowName === 'Fable limit', show(usage.bindingWindowFor(FABLE)))
  check('an Opus session is not bound by it', usage.bindingWindowFor('claude-opus-5-5')?.window.key === '7d', show(usage.bindingWindowFor('claude-opus-5-5')))
}

section('§3 nothing when the reply states no such pool')
{
  await readEndpoint(liveBody(body => { body.limits = body.limits.filter(r => r.kind !== 'weekly_scoped') }))
  check('without the scoped row the rail paints 5h and 7d alone', poolsNow() === '' && railMeters().length === 2, `${poolsNow()} | ${show(railMeters())}`)
  await readEndpoint(liveBody(body => { delete (body as Record<string, unknown>).limits }))
  check('a reply with no limits[] at all (an older server) reads as before', poolsNow() === '' && railMeters().length === 2, poolsNow())
  await readEndpoint(liveBody(body => { for (const row of body.limits) if (row.kind === 'weekly_scoped') row.resets_at = null }))
  check('a scoped row with no reset is not painted (the rule every window follows)', poolsNow() === '', poolsNow())
  await readEndpoint(liveBody(body => { for (const row of body.limits) if (row.kind === 'weekly_scoped') row.scope = { model: null, surface: { display_name: 'Design' } } }))
  check('a row scoped to a surface, not a model, is no model pool', poolsNow() === '', poolsNow())
  await readEndpoint(liveBody(body => { for (const row of body.limits) if (row.kind === 'weekly_scoped') row.scope!.model!.display_name = 'Lantern' }))
  check('a scoped row naming no family Mercury pools is not painted as another family', poolsNow() === '', poolsNow())
  await readEndpoint(liveBody(body => { for (const row of body.limits) if (row.kind === 'weekly_scoped') row.kind = 'weekly_all' }))
  check('the row kind decides, never the label: a weekly_all row named Fable is no pool', poolsNow() === '', poolsNow())
}

section('§4 one row a pool, whatever states it')
{
  await readEndpoint(liveBody(body => { body.seven_day_fable = { utilization: 87, resets_at: iso(NOW + 3 * DAY) } }))
  check("a reply that carries both the object and the row paints the object's figure (the reader that stood)", poolsNow() === 'seven_day_fable:Fable:87:endpoint' && railMeters().filter(m => m.startsWith('Fable')).length === 1, `${poolsNow()} | ${show(railMeters())}`)
  await readEndpoint(liveBody(body => { body.limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: 9, resets_at: iso(NOW + 6 * DAY), scope: { model: { id: null, display_name: 'Fable 5.1' }, surface: null } }) }))
  check('two scoped rows of one family paint once, the first as the server orders them', poolsNow() === 'seven_day_fable:Fable:42:endpoint', poolsNow())
  await readEndpoint(liveBody(body => {
    body.limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: 12, resets_at: iso(NOW + 6 * DAY), scope: { model: { id: null, display_name: 'Opus' }, surface: null } })
    body.limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: 20, resets_at: iso(NOW + 6 * DAY), scope: { model: { id: null, display_name: 'Sonnet' }, surface: null } })
  }))
  check('scoped rows for the other pooled families feed their own pools', poolsNow() === 'seven_day_fable:Fable:42:endpoint · seven_day_opus:Opus:12:endpoint · seven_day_sonnet:Sonnet:20:endpoint', poolsNow())
}

section("§5 the reader states the reply's shape once in the debug log: keys and row kinds, never a figure or an id")
{
  const words = limits.usagePayloadShapeWords(recorded.body)
  check('it names the stated keys and the null ones', words.includes('stated extra_usage, five_hour, limits') && words.includes('seven_day_opus') && words.includes(' · null '), words)
  check('it names each limits[] row by kind, group and scope name', words.includes(`limits session/session, weekly_all/weekly, weekly_scoped/weekly model ${MASKED_NAME}`), words)
  check('it carries no figure of the reply', !/\b(20|22|42)\b/.test(words) && !words.includes('2026-'), words)
  check('a reply that is no object says so', limits.usagePayloadShapeWords(null) === 'no object' && limits.usagePayloadShapeWords([]) === 'no object')
  const reader = readFileSync(join(ROOT, 'src/services/providers/anthropic/anthropicUsageState.ts'), 'utf8')
  check('the usage reader logs it after an answered read, once', (reader.match(/usagePayloadShapeWords\(/g) ?? []).length === 1 && reader.includes('[usage] read #${request} payload shape · '))
}

const windows = JSON.parse(readFileSync(join(ROOT, 'scripts/providers/fixtures/anthropic-unified-windows-2026-11-09.json'), 'utf8')) as {
  read: string
  windows: Array<[string, string]>
  fields: string[]
  claimNames: Record<string, string>
  reply: Record<string, string>
  refusal: Record<string, string>
}
const nowSeconds = Math.floor(NOW / 1000)
function headersOf(shape: Record<string, string>, over: Record<string, string | null> = {}): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries({ ...shape, ...over })) {
    if (value === null) continue
    headers.set(name, value.startsWith('+') ? String(nowSeconds + Number(value.slice(1))) : value)
  }
  return headers
}
const POOL_HEADERS = ['anthropic-ratelimit-unified-7d_oi-utilization', 'anthropic-ratelimit-unified-7d_oi-reset', 'anthropic-ratelimit-unified-7d_oi-status']
const withoutPool = Object.fromEntries(POOL_HEADERS.map(name => [name, null]))
const { providerLimitWarning } = await import('../../src/services/providers/limitWarning.ts')

section(`§6 the reply headers (scripts/providers/fixtures/anthropic-unified-windows-2026-11-09.json, the provider's published client read ${windows.read} — its code, not a documented API): the 7d_oi window is the Fable week`)
{
  check("the client pairs the window it names 'Fable limit' with the abbreviation 7d_oi, beside 5h and 7d", windows.windows.map(w => w.join(':')).join(' ') === 'five_hour:5h seven_day:7d seven_day_overage_included:7d_oi overage:overage' && windows.claimNames.seven_day_overage_included === 'Fable limit' && windows.fields.includes('utilization') && windows.fields.includes('reset'))
  limits.resetLimitsForCredentialSwitch()
  delete process.env.MERCURY_MOCK_USAGE_PAYLOAD
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply), Date.now())
  check('a reply that carries the window gives the pool view: Fable at 61%, fed by the headers, with the window\'s reset', poolsNow() === 'seven_day_fable:Fable:61:headers' && usage.anthropicPoolWindowViews()[0]?.resetsAtMs === (nowSeconds + 529200) * 1000, poolsNow())
  const meters = railMeters()
  check('the USAGE rail paints 5h, 7d and Fable from that one reply', meters.length === 3 && meters[0]!.startsWith('5h 36%') && meters[1]!.startsWith('7d 44%') && /^Fable 61% 6d/.test(meters[2]!), show(meters))
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply, withoutPool), Date.now() + 1)
  check('the next reply without the window takes the row away (no figure outlives the reply that stated it)', poolsNow() === '' && railMeters().length === 2, `${poolsNow()} | ${show(railMeters())}`)
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply, { 'anthropic-ratelimit-unified-7d_oi-reset': null }), Date.now() + 2)
  check('a window with a figure and no reset is not painted', poolsNow() === '', poolsNow())
}

section('§7 one row a pool: the fresher of the reply and the endpoint, as 5h and 7d already choose')
{
  await readEndpoint(liveBody())
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply), Date.now() + 5)
  check('a reply read after the endpoint: its figure is the row (61%, headers)', poolsNow() === 'seven_day_fable:Fable:61:headers', poolsNow())
  limits.foldUtilizationFromEndpoint(liveBody(), undefined, Date.now() + 60_000)
  check('an endpoint read after that reply: its figure is the row (42%, endpoint)', poolsNow() === 'seven_day_fable:Fable:42:endpoint', poolsNow())
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply, withoutPool), Date.now() + 120_000)
  check('a later reply that states no pool leaves the endpoint\'s reading standing, with its own age', poolsNow() === 'seven_day_fable:Fable:42:endpoint', poolsNow())
}

section('§8 the pool binds the Fable session alone, and its warning is the existing pool sentence')
{
  limits.resetLimitsForCredentialSwitch()
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply, { 'anthropic-ratelimit-unified-7d_oi-utilization': '0.92' }), Date.now())
  const fable = providerLimitWarning({ model: FABLE })
  check("a Fable session at 92% of the pool reads 'Anthropic: 92% of the Fable limit used · resets …'", fable !== null && /^Anthropic: 92% of the Fable limit used · resets /.test(fable.text), show(fable))
  const opus = providerLimitWarning({ model: 'claude-opus-5-5' })
  check('an Opus session beside it is not warned (its own windows read 36% and 44%)', opus === null, show(opus))
  check('the Mythos mirror is the same pool', usage.bindingWindowFor('claude-mythos-5-2')?.window.key === 'seven_day_fable', show(usage.bindingWindowFor('claude-mythos-5-2')))
}

section("§9 the runner's reading reaches the window process: the relay carries the pool beside 5h and 7d")
{
  limits.resetLimitsForCredentialSwitch()
  limits.extractQuotaStatusFromHeaders(headersOf(windows.reply), Date.now())
  const fact = limits.anthropicObservedUsage() as (Record<string, unknown> & { owner: string }) | undefined
  check('the relayed fact carries sevenDayFable (utilization, resetsAt, observedAtMs) beside fiveHour and sevenDay', fact !== undefined && typeof fact.fiveHour === 'object' && typeof fact.sevenDay === 'object' && show(Object.keys((fact.sevenDayFable ?? {}) as object).sort()) === show(['observedAtMs', 'resetsAt', 'utilization']) && (fact.sevenDayFable as { utilization: number }).utilization === 0.61, show(fact))
  const at = Date.now() + 10
  const written = {
    owner: OWNER,
    fiveHour: { utilization: 0.36, resetsAt: nowSeconds + 7800, observedAtMs: at },
    sevenDay: { utilization: 0.44, resetsAt: nowSeconds + 529200, observedAtMs: at },
    sevenDayFable: { utilization: 0.61, resetsAt: nowSeconds + 529200, observedAtMs: at },
  }
  const firstTwo = (): string => railMeters().slice(0, 2).map(m => m.split(' ').slice(0, 2).join(' ')).join(' · ')
  limits.resetLimitsForCredentialSwitch()
  const whole = limits.adoptAnthropicObservedUsage(written)
  check('a V1 record written with the field is adopted, and its 5h and 7d paint (what a window on an older build reads from a newer runner)', whole && firstTwo() === '5h 36% · 7d 44%', `${whole} ${firstTwo()}`)
  check('…and a window on this build paints the pool from it: the same three rows the runner read', poolsNow() === 'seven_day_fable:Fable:61:headers' && railMeters().length === 3, poolsNow())
  limits.resetLimitsForCredentialSwitch()
  const { sevenDayFable: _left, ...older } = written
  const bare = limits.adoptAnthropicObservedUsage(older)
  check('a V1 record without the field (an older runner) is adopted as before: 5h and 7d, no pool', bare && firstTwo() === '5h 36% · 7d 44%' && poolsNow() === '' && railMeters().length === 2, `${bare} ${poolsNow()}`)
  limits.resetLimitsForCredentialSwitch()
  check('a malformed pool beside whole windows drops the pool alone', limits.adoptAnthropicObservedUsage({ ...written, sevenDayFable: { utilization: 'much', resetsAt: nowSeconds + 60, observedAtMs: at } }) && poolsNow() === '' && firstTwo() === '5h 36% · 7d 44%', poolsNow())
  const types = readFileSync(join(ROOT, 'src/services/engine-connector/types.ts'), 'utf8')
  check('the field is optional on the V1 fact, and nothing but that declaration names it in the wire types', (types.match(/sevenDayFable/g) ?? []).length === 1 && types.includes('  sevenDayFable?: AnthropicObservedWindowV1\n'))
}

limits.__setAnthropicOwnerResolverForTest(null)
delete process.env.MERCURY_MOCK_USAGE_PAYLOAD
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
