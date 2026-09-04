#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-usage-freshness-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_LIMITS', 'MERCURY_MOCK_USAGE_PAYLOAD', 'MERCURY_USAGE_POLL_MS', 'NODE_ENV', 'CI']) {
  delete process.env[name]
}
const seedSubscriber = (expiresAt: number): void => {
  writeFileSync(
    join(scratch, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
  )
}
seedSubscriber(Date.now() + 7 * 24 * 3600 * 1000)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([])
process.env.ANTHROPIC_BASE_URL = api.url
const hoursOn = (h: number): string => new Date(Date.now() + h * 3600e3).toISOString()
api.usage.payload = (n: number) => ({
  five_hour: { utilization: 26 + 10 * n, resets_at: hoursOn(2) },
  seven_day: { utilization: 44, resets_at: hoursOn(6 * 24) },
  seven_day_fable: { utilization: 87, resets_at: hoursOn(22) },
})

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const fresh = await import('../../src/services/providers/usageFreshness.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const limits = await import('../../src/services/claudeAiLimits.ts')
const reader = await import('../../src/services/providers/anthropic/anthropicUsageState.ts')
const auth = await import('../../src/utils/auth.ts')

const MIN = 60_000
const HOUR = 3_600_000
let NOW = 1_760_000_000_000
const clock = (): number => NOW

console.log('the usage figure carries its age, refreshes on its cadence, and a failed read speaks')

section("§1 the age: '↻12s' live · 'stale ↻2m' past twice the cadence · one vocabulary")
{
  const ttl = fresh.usagePollTtlMs()
  check('the poll cadence unset is the readers\' minute', ttl === 60_000 && fresh.USAGE_POLL_TTL_MS === 60_000, String(ttl))
  check('a polled figure reads stale past TWICE the cadence (one missed poll tolerated)', fresh.usageStaleAfterMs() === 2 * ttl && fresh.usageFreshHorizonMs('endpoint') === 2 * ttl)
  const at = { source: 'endpoint' as const, observedAtMs: NOW - 12_000 }
  check("live: '↻12s'", fresh.usageAgeTail(at, NOW) === '↻12s', fresh.usageAgeTail(at, NOW))
  check("live at the edge (2 × TTL): still '↻2m'", fresh.usageAgeTail({ ...at, observedAtMs: NOW - 2 * ttl }, NOW) === '↻2m', fresh.usageAgeTail({ ...at, observedAtMs: NOW - 2 * ttl }, NOW))
  check("stale one second past the edge: 'stale ↻2m' (the word leads, so a truncated row keeps the verdict)", fresh.usageAgeTail({ ...at, observedAtMs: NOW - 2 * ttl - 1_000 }, NOW) === 'stale ↻2m', fresh.usageAgeTail({ ...at, observedAtMs: NOW - 2 * ttl - 1_000 }, NOW))
  check("two hours on: 'stale ↻2h'", fresh.usageAgeTail({ ...at, observedAtMs: NOW - 2 * HOUR - 5 * MIN }, NOW) === 'stale ↻2h')
  check("the block words: 'read 12 s ago' · 'stale · last read 2 h 5 min ago'", fresh.usageAgeWords(at, NOW) === 'read 12 s ago' && fresh.usageAgeWords({ ...at, observedAtMs: NOW - 2 * HOUR - 5 * MIN }, NOW) === 'stale · last read 2 h 5 min ago', `${fresh.usageAgeWords(at, NOW)} | ${fresh.usageAgeWords({ ...at, observedAtMs: NOW - 2 * HOUR - 5 * MIN }, NOW)}`)
  check('an unstamped figure and a seed carry no age (never a fabricated age)', fresh.usageAgeTail({ source: 'endpoint' }, NOW) === undefined && fresh.usageAgeTail({ source: 'seed', observedAtMs: NOW - HOUR }, NOW) === undefined && fresh.usageAgeWords({}, NOW) === undefined)
  check('the stale-only tail keeps its contract for the credits line (nothing while live)', fresh.usageStaleTail(at, NOW) === undefined && fresh.usageStaleTail({ ...at, observedAtMs: NOW - 3 * ttl }, NOW) === '↻3m')
  process.env.MERCURY_USAGE_POLL_MS = '5000'
  check('the seam shortens the cadence (5 s) and the horizon with it (10 s)', fresh.usagePollTtlMs() === 5_000 && fresh.usageStaleAfterMs() === 10_000)
  process.env.MERCURY_USAGE_POLL_MS = '10'
  check('below a second the seam is ignored (the minute stands)', fresh.usagePollTtlMs() === 60_000)
  process.env.MERCURY_USAGE_POLL_MS = 'soon'
  check('junk is ignored', fresh.usagePollTtlMs() === 60_000)
  delete process.env.MERCURY_USAGE_POLL_MS
  limits.resetLimitsForCredentialSwitch()
  limits.foldUtilizationFromEndpoint({ five_hour: { utilization: 36, resets_at: hoursOn(1) }, seven_day: { utilization: 44, resets_at: hoursOn(24) }, seven_day_fable: { utilization: 87, resets_at: hoursOn(24) } }, undefined, NOW - 30_000)
  const views = [...owner.anthropicWindowViews(), ...owner.anthropicPoolWindowViews()]
  check('the folded pair and pool carry the poll horizon (2 × TTL), one stamp', views.length === 3 && views.every(v => v.freshForMs === fresh.usageStaleAfterMs() && v.observedAtMs === NOW - 30_000), JSON.stringify(views))
  check('…so at 30 s they are live and at 2 min 1 s they are stale by the one test', !owner.usageViewIsStale(views[0]!, NOW) && owner.usageViewIsStale(views[0]!, NOW + 2 * ttl + 1_000 - 30_000 + 30_000))
  limits.resetLimitsForCredentialSwitch()
}

section('§2 the cadence: TTL-bounded · single-flight · a turn asks ahead · the operator always · a failure backs off, is logged and recorded once, and speaks')
{
  reader._resetAnthropicUsageReaderForTesting()
  limits.resetLimitsForCredentialSwitch()
  const ttl = fresh.usagePollTtlMs()
  const host = `127.0.0.1:${api.port}`
  check('the reader is gated on the subscription and reads the fixture host', auth.isClaudeAISubscriber() && reader.anthropicUsageReadStatus().requests === 0)
  let status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('the first poll asks the endpoint once and folds the answer (5h 36%)', status.requests === 1 && api.usageRequests.length === 1 && Math.round(owner.anthropicWindowViews()[0]?.usedPct ?? -1) === 36, JSON.stringify(status))
  NOW += ttl / 2
  status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('a poll inside the TTL asks nothing', status.requests === 1 && api.usageRequests.length === 1)
  status = await reader.refreshAnthropicUsage({ reason: 'turn', now: clock })
  check('a completed turn asks AHEAD of the cadence (5h 46%)', status.requests === 2 && Math.round(owner.anthropicWindowViews()[0]?.usedPct ?? -1) === 46, JSON.stringify(status))
  NOW += 1_000
  status = await reader.refreshAnthropicUsage({ reason: 'turn', now: clock })
  check('…but a burst of turn asks coalesces inside the two-second floor', status.requests === 2)
  NOW += ttl
  const twin = await Promise.all([reader.refreshAnthropicUsage({ reason: 'poll', now: clock }), reader.refreshAnthropicUsage({ reason: 'poll', now: clock })])
  check('two concurrent asks are ONE request (single-flight)', twin[0]!.requests === 3 && twin[1]!.requests === 3 && api.usageRequests.length === 3, JSON.stringify(twin.map(t => t.requests)))
  status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  check('the operator\'s own ask is never refused (4 requests)', status.requests === 4 && status.failure === undefined)
  check('no note while the reader answers', reader.anthropicUsageReaderNote(NOW) === undefined && owner.usageForProvider('anthropic').readerNote === undefined)

  let signals = 0
  const unsubscribe = limits.subscribeUsageRecord(() => {
    signals++
  })
  api.usage.mode = 'error'
  api.usage.status = 500
  NOW += ttl
  status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('a 500 is a failure the reader names: HTTP 500 from the host', status.failure?.kind === 'http' && status.failure.status === 500 && status.failure.host === host, JSON.stringify(status.failure))
  check('…and backs off FOUR cadences', status.retryAtMs === NOW + 4 * ttl, String(status.retryAtMs))
  check('…and the painters\' change signal fired', signals >= 1)
  const note = reader.anthropicUsageReaderNote(NOW)
  check("the prose note: 'usage endpoint answered HTTP 500 (host) · retry in 4 min'", note === `usage endpoint answered HTTP 500 (${host}) · retry in 4 min`, note)
  check("the compact note fits a rail row: 'read failed · HTTP 500'", reader.anthropicUsageReaderNote(NOW, 'compact') === 'read failed · HTTP 500', reader.anthropicUsageReaderNote(NOW, 'compact'))
  const view = owner.usageForProvider('anthropic')
  const failedWords = `usage endpoint answered HTTP 500 (${host})`
  check('the owner\'s view carries both spellings and the last figure still stands (5h 66%)', view.readerNote?.startsWith(`${failedWords} · retry`) === true && view.readerNoteCompact === 'read failed · HTTP 500' && Math.round(view.windows[0]?.usedPct ?? -1) === 66, JSON.stringify({ note: view.readerNote, compact: view.readerNoteCompact, pct: view.windows[0]?.usedPct }))
  check('the doctor\'s summary carries the note', owner.usageSummaryWords(view, NOW).includes(failedWords), owner.usageSummaryWords(view, NOW))
  const recordPath = reader.usageReaderRecordPath()
  const record = (): Record<string, unknown> => JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
  const first = existsSync(recordPath) ? (record().families as Record<string, Record<string, unknown>>).anthropic : undefined
  check("the doctor's record was written ONCE with the status and the host", first?.status === 500 && first?.host === host && first?.recoveredAtMs === undefined, existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : 'absent')
  NOW += 2 * ttl
  status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('a poll inside the backoff asks nothing (no silent retry loop)', status.requests === 5 && api.usageRequests.length === 5)
  status = await reader.refreshAnthropicUsage({ reason: 'turn', now: clock })
  check('…a turn inside the backoff asks nothing either', status.requests === 5)
  NOW += 2 * ttl + 1_000
  const signalsBefore = signals
  status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('past the backoff the poll tries again (no silent stop) — and fails again', status.requests === 6 && status.failure?.status === 500 && status.consecutiveFailures === 2)
  const again = (record().families as Record<string, Record<string, unknown>>).anthropic
  check('a repeat inside the episode rewrites nothing (the record keeps its first stamp)', again?.failedAtMs === first?.failedAtMs, JSON.stringify(again))
  check('the note names the new retry', reader.anthropicUsageReaderNote(NOW) === `usage endpoint answered HTTP 500 (${host}) · retry in 4 min`)
  api.usage.mode = 'ok'
  NOW += 4 * ttl + 1_000
  status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('the endpoint answers again: the failure clears and the figure moves (5h 96%)', status.failure === undefined && status.consecutiveFailures === 0 && status.retryAtMs === undefined && Math.round(owner.anthropicWindowViews()[0]?.usedPct ?? -1) === 96, JSON.stringify(status))
  check('the note is gone from the owner\'s view', owner.usageForProvider('anthropic').readerNote === undefined)
  check('…and the change signal fired for the recovery too', signals > signalsBefore)
  const recovered = (record().families as Record<string, Record<string, unknown>>).anthropic
  check("the doctor's record carries the recovery", typeof recovered?.recoveredAtMs === 'number' && recovered.status === 500, JSON.stringify(recovered))
  const words = reader.usageReaderRecordWords()
  check("the doctor's words: 'last usage read failure: HTTP 500 from host at HH:MM · recovered HH:MM'", new RegExp(`^last usage read failure: HTTP 500 from ${host.replace('.', '\\.')} at \\d{2}:\\d{2} · recovered \\d{2}:\\d{2}$`).test(words ?? ''), words)
  check('…and the owner\'s summary carries it for a doctor in another process', owner.usageSummaryWords(owner.usageForProvider('anthropic'), NOW).includes(words!), owner.usageSummaryWords(owner.usageForProvider('anthropic'), NOW))
  unsubscribe()

  api.usage.mode = 'hang'
  NOW += ttl + 1_000
  const started = Date.now()
  status = await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  const waited = Date.now() - started
  check(`a hung endpoint fails as a timeout after the read's five seconds (${(waited / 1000).toFixed(1)} s)`, status.failure?.kind === 'timeout' && waited >= 4_500 && waited < 9_000, JSON.stringify(status.failure))
  check("the compact note names it: 'read failed · timeout'", reader.anthropicUsageReaderNote(NOW, 'compact') === 'read failed · timeout', reader.anthropicUsageReaderNote(NOW, 'compact'))
  check("the prose note: 'usage endpoint did not answer within 5 s (host) · retry in 4 min'", reader.anthropicUsageReaderNote(NOW) === `usage endpoint did not answer within 5 s (${host}) · retry in 4 min`, reader.anthropicUsageReaderNote(NOW))
  const frozen = (record().families as Record<string, Record<string, unknown>>).anthropic
  check('a new episode (a new class) is recorded anew', frozen?.kind === 'timeout' && frozen.recoveredAtMs === undefined, JSON.stringify(frozen))
  api.usage.mode = 'ok'
  NOW += 4 * ttl + 1_000
  await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  check('…and recovers', reader.anthropicUsageReadStatus().failure === undefined)
}

section('§3 one owner: the door routes through the reader · the freshest observation wins per window · every painter reads the one age composer · the poll driver')
{
  const before = reader.anthropicUsageReadStatus().requests
  NOW += fresh.usagePollTtlMs() + 1_000
  await owner.refreshProviderUsage('anthropic', { reason: 'poll', now: clock })
  check('refreshProviderUsage(anthropic) is the reader (one request through the door)', reader.anthropicUsageReadStatus().requests === before + 1)
  const door = src('src/services/providers/providerUsage.ts')
  check('…by source: the door requires the reader, never the raw fetch', door.includes("require('./anthropic/anthropicUsageState.js')") && !door.includes('await fetchUtilization()'))
  limits.resetLimitsForCredentialSwitch()
  limits.__setRawUtilizationForTest({ five_hour: { utilization: 0.11, resets_at: NOW / 1000 + 3600, source: 'headers', observedAtMs: NOW } })
  limits.foldUtilizationFromEndpoint({ five_hour: { utilization: 36, resets_at: hoursOn(1) }, seven_day: { utilization: 44, resets_at: hoursOn(24) } }, undefined, NOW + 1_000)
  let raw = limits.getRawUtilization()
  check('an endpoint answer FRESHER than the header observation wins the window (36, not the 11 the boot probe saw)', Math.round((raw.five_hour?.utilization ?? 0) * 100) === 36 && raw.five_hour?.source === 'endpoint', JSON.stringify(raw.five_hour))
  check('…and fills the window the headers never stated (7d 44)', Math.round((raw.seven_day?.utilization ?? 0) * 100) === 44)
  limits.__setRawUtilizationForTest({ five_hour: { utilization: 0.12, resets_at: NOW / 1000 + 3600, source: 'headers', observedAtMs: NOW + 2_000 } })
  raw = limits.getRawUtilization()
  check('a reply\'s headers FRESHER than the endpoint answer win back (12)', Math.round((raw.five_hour?.utilization ?? 0) * 100) === 12 && raw.five_hour?.source === 'headers', JSON.stringify(raw.five_hour))
  limits.__setRawUtilizationForTest({ five_hour: { utilization: 0.13, resets_at: NOW / 1000 + 3600 } })
  raw = limits.getRawUtilization()
  check('a bare header record (no stamp — a proof seam) keeps the header precedence', Math.round((raw.five_hour?.utilization ?? 0) * 100) === 13)
  limits.resetLimitsForCredentialSwitch()
  const painters = [
    ['src/components/HelmTelemetryRail.tsx', 'usageAgeTail(w, readNow)'],
    ['src/components/MercuryFrame.tsx', 'usageAgeTail(first, usageNow)'],
    ['src/components/DeckPane.tsx', 'usageAgeTail(stripFirst, now)'],
    ['src/components/HelmLanesRail.tsx', 'usageAgeTail(lead, Date.now())'],
    ['src/components/Deck.tsx', 'usageSourceWords(freshest, now)'],
    ['src/components/Settings/Usage.tsx', 'usageSourceWords(w)'],
  ] as const
  for (const [file, call] of painters) {
    const text = src(file)
    const code = text.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    check(`${file} paints the read's age through the owner (${call}) and spells no age word of its own`, text.includes(call) && !/['`]↻/.test(code) && !code.includes("'stale ") && !code.includes('last read'), file)
  }
  const rail = src('src/components/HelmTelemetryRail.tsx')
  check('the rail paints the reader\'s compact note under the meters', rail.includes('usage.readerNoteCompact') && rail.includes("key=\"usage:reader\""))
  const deck = src('src/components/Deck.tsx')
  check('/deck paints the reader\'s note', deck.includes('usage.readerNote') && deck.includes('key="reader"'))
  const tab = src('src/components/Settings/Usage.tsx')
  check("the tab's own ask rides the owner's door as the operator (never the raw fetch, never a reader import)", tab.includes("refreshProviderUsage('anthropic', { reason: 'operator' })") && !tab.includes('fetchUtilization()') && !tab.includes('anthropicUsageState'))
  const frame = src('src/components/MercuryFrame.tsx')
  check('a completed turn pokes the reader from the frame (the focused session\'s own totals)', frame.includes('pokeProviderUsage()') && frame.includes('[usageFacts.totalOutputTokens, usageFacts.totalAPIDurationMs]'))
  const boot = src('src/main.tsx')
  check('the interactive boot arms the poll on the focused family; nothing headless does', boot.includes("registerBackgroundNode('usage-poll'") && boot.includes('armProviderUsagePoll({') && !src('src/cli/print.ts').includes('armProviderUsagePoll'))
  process.env.MERCURY_USAGE_POLL_MS = '3000'
  reader._resetAnthropicUsageReaderForTesting()
  const asked = api.usageRequests.length
  const disarm = owner.armProviderUsagePoll({ family: () => 'anthropic' })
  check('the driver is armed once (idempotent)', owner.providerUsagePollArmed())
  await sleep(3_400)
  check('the poll asked the endpoint on its cadence', api.usageRequests.length >= asked + 1, `${api.usageRequests.length - asked} request(s) in 3.4 s`)
  const beforePoke = api.usageRequests.length
  await sleep(1_700)
  owner.pokeProviderUsage()
  await sleep(300)
  check('a poke asks ahead of the cadence', api.usageRequests.length >= beforePoke + 1, `${api.usageRequests.length - beforePoke}`)
  disarm()
  check('the disarm stops it', !owner.providerUsagePollArmed())
  const settled = api.usageRequests.length
  await sleep(3_400)
  check('…and no request lands after the disarm', api.usageRequests.length === settled)
  owner.pokeProviderUsage()
  await sleep(200)
  check('a poke with no poll armed is a no-op (a headless process)', api.usageRequests.length === settled)
  delete process.env.MERCURY_USAGE_POLL_MS
}

section('§4 the subscription window: the OAuth account\'s windows and pools ride one stamp and one horizon; no subscription, no ask')
{
  reader._resetAnthropicUsageReaderForTesting()
  limits.resetLimitsForCredentialSwitch()
  NOW += fresh.usagePollTtlMs() + 1_000
  await reader.refreshAnthropicUsage({ reason: 'poll', now: clock })
  const view = owner.usageForProvider('anthropic')
  const stamps = new Set([...view.windows, ...view.pools].map(w => `${w.source}:${w.observedAtMs}:${w.freshForMs}`))
  check('the 5h/7d pair and the Fable pool fold from the one answer with one stamp and one horizon', view.windows.length === 2 && view.pools.length === 1 && stamps.size === 1, JSON.stringify([...stamps]))
  check('the view is the subscription\'s own (Claude Max · Anthropic usage)', view.sourceKind === 'subscription-oauth' && view.tier === 'Claude Max' && view.label === 'Anthropic usage')
  check("every window's age words come from the one composer ('endpoint-fed · read 0 s ago')", fresh.usageSourceWords(view.windows[0]!, view.windows[0]!.observedAtMs!) === 'endpoint-fed · read 0 s ago')
  rmSync(join(scratch, '.credentials.json'), { force: true })
  auth.dropCredentialMemos()
  const asked = api.usageRequests.length
  NOW += fresh.usagePollTtlMs() + 1_000
  const status = await reader.refreshAnthropicUsage({ reason: 'operator', now: clock })
  check('with no subscription the reader asks nothing (not a failure, not a request)', api.usageRequests.length === asked && status.failure === undefined, JSON.stringify(status))
  seedSubscriber(Date.now() + 7 * 24 * 3600 * 1000)
  auth.dropCredentialMemos()
}

section('§5 the account behind the family moves: a sign-in or a removal forgets the reader and asks for the account now signed in at once — never the departed figure, never its cadence or backoff')
{
  const { saveOAuthTokensIfNeeded, clearOAuthTokenCache } = auth
  const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.ts')
  const { recordSignIn, noteCredentialChange, signInLedgerEpoch } = await import('../../src/utils/accounts/signInLedger.ts')
  const { signOutAnthropicSlot } = await import('../../src/services/providers/accountSlots.ts')
  const tokensFor = (name: 'A' | 'B') => ({
    accessToken: `fixture-token-${name}`,
    refreshToken: `fixture-refresh-${name}`,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max' as const,
    rateLimitTier: null,
  })
  const signIn = (name: 'A' | 'B'): void => {
    storeOAuthAccountInfo({ accountUuid: `account-${name}`, emailAddress: `${name.toLowerCase()}@example.invalid` })
    const saved = saveOAuthTokensIfNeeded(tokensFor(name))
    if (!saved.success) throw new Error(saved.warning ?? 'the fixture credential did not save')
    clearOAuthTokenCache()
    recordSignIn('anthropic', 'oauth')
  }
  const removeSignIn = (): void => {
    signOutAnthropicSlot(scratch, { revoke: async () => undefined })
    noteCredentialChange()
  }
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) {
      await sleep(50)
      if (!reader.anthropicUsageReadStatus().inFlight) return
    }
  }
  const fiveHour = (): { pct?: number; at?: number; state: string } => {
    const w = owner.anthropicWindowViews()[0]!
    return { ...(w.usedPct !== undefined ? { pct: Math.round(w.usedPct) } : {}), ...(w.observedAtMs !== undefined ? { at: w.observedAtMs } : {}), state: w.state }
  }
  const bearers: string[] = []
  api.usage.mode = 'ok'
  api.usage.next = undefined
  api.usage.payload = (_n, bearer) => {
    bearers.push(bearer ?? '(none)')
    if (bearer === 'Bearer fixture-token-A') return { five_hour: { utilization: 36, resets_at: hoursOn(2) }, seven_day: { utilization: 44, resets_at: hoursOn(24) } }
    if (bearer === 'Bearer fixture-token-B') return { five_hour: { utilization: 77, resets_at: hoursOn(3) }, seven_day: { utilization: 12, resets_at: hoursOn(24) } }
    return {}
  }
  removeSignIn()
  reader._resetAnthropicUsageReaderForTesting()
  limits.resetLimitsForCredentialSwitch()
  const disarm = owner.armProviderUsagePoll({ family: () => 'anthropic' })
  const asksBefore = reader.anthropicUsageReadStatus().requests

  const epochBefore = signInLedgerEpoch()
  const tA = Date.now()
  signIn('A')
  check('a sign-in bumps the ledger epoch (the one signal)', signInLedgerEpoch() === epochBefore + 1)
  await settled()
  let view = fiveHour()
  check(`A's sign-in refetched at once through the epoch (5h ${view.pct}% for A, read at the sign-in)`, view.state === 'live' && view.pct === 36 && (view.at ?? 0) >= tA && reader.anthropicUsageReadStatus().requests === asksBefore + 1, JSON.stringify({ view, status: reader.anthropicUsageReadStatus() }))
  check("…with A's bearer on the wire", bearers.at(-1) === 'Bearer fixture-token-A', bearers.join(','))

  removeSignIn()
  await settled()
  view = fiveHour()
  check("A's removal empties the meter (never A's figure) and asks nothing — no account is signed in", view.state === 'unavailable' && reader.anthropicUsageReadStatus().requests === asksBefore + 1 && reader.anthropicUsageReadStatus().failure === undefined, JSON.stringify({ view, status: reader.anthropicUsageReadStatus() }))

  const tB = Date.now()
  signIn('B')
  await settled()
  view = fiveHour()
  check(`B's sign-in refetched at once — inside A's old cadence — and the meter paints B's figure (5h ${view.pct}%) with its own age`, view.state === 'live' && view.pct === 77 && (view.at ?? 0) >= tB && reader.anthropicUsageReadStatus().requests === asksBefore + 2, JSON.stringify({ view, status: reader.anthropicUsageReadStatus() }))
  check("…with B's bearer on the wire, and A's number never painted after the removal", bearers.at(-1) === 'Bearer fixture-token-B' && Math.round(owner.anthropicWindowViews()[1]?.usedPct ?? -1) === 12, bearers.join(','))
  check('the doctor\'s summary is B\'s (Claude Max · 5h 77%)', owner.usageSummaryWords(owner.usageForProvider('anthropic'), Date.now()).startsWith('Claude Max · 5h 77%'), owner.usageSummaryWords(owner.usageForProvider('anthropic'), Date.now()))

  api.usage.mode = 'hang'
  NOW = Date.now()
  const hung = reader.refreshAnthropicUsage({ reason: 'operator' })
  await sleep(100)
  check('an operator ask is in flight against a hung endpoint', reader.anthropicUsageReadStatus().inFlight)
  api.usage.mode = 'ok'
  removeSignIn()
  signIn('A')
  await settled()
  view = fiveHour()
  check("the account moved while an ask hung: the new account's ask answered at once (5h 36% for A)", view.state === 'live' && view.pct === 36, JSON.stringify(view))
  await hung
  check('…and the hung ask settled into nothing — no failure, no backoff, the figure untouched', reader.anthropicUsageReadStatus().failure === undefined && reader.anthropicUsageReadStatus().retryAtMs === undefined && fiveHour().pct === 36, JSON.stringify(reader.anthropicUsageReadStatus()))
  removeSignIn()
  await settled()
  view = fiveHour()
  check('a removal with no successor paints the blank and asks nothing', view.state === 'unavailable' && reader.anthropicUsageReadStatus().requests === asksBefore + 4 && reader.anthropicUsageReadStatus().inFlight === false, JSON.stringify({ view, status: reader.anthropicUsageReadStatus() }))
  signIn('A')
  await settled()
  check("A is back and read (5h 36%)", fiveHour().pct === 36 && bearers.at(-1) === 'Bearer fixture-token-A')
  const saved = saveOAuthTokensIfNeeded(tokensFor('B'))
  if (!saved.success) throw new Error('the fixture swap did not save')
  const before = reader.anthropicUsageReadStatus().requests
  recordSignIn('anthropic', 'oauth')
  await Promise.resolve()
  const dropped = fiveHour()
  await settled()
  view = fiveHour()
  check("a bump whose road forgot the reset: the reader dropped A's figure at once (the blank on the bump) and painted B's (5h 77%)", dropped.state === 'unavailable' && view.pct === 77 && bearers.at(-1) === 'Bearer fixture-token-B' && reader.anthropicUsageReadStatus().requests === before + 1, JSON.stringify({ dropped, view }))
  const standing = reader.anthropicUsageReadStatus().requests
  recordSignIn('openai', 'api-key')
  const held = fiveHour()
  await settled()
  check("another family's sign-in never blanks the meter: B's figure stood through the bump and was re-read once", held.state === 'live' && held.pct === 77 && fiveHour().pct === 77 && reader.anthropicUsageReadStatus().requests === standing + 1, JSON.stringify({ held, after: fiveHour() }))
  check('the sign-in subscription is the driver\'s: disarmed, a sign-in asks nothing', (() => {
    disarm()
    const asks = reader.anthropicUsageReadStatus().requests
    removeSignIn()
    signIn('B')
    return reader.anthropicUsageReadStatus().requests === asks
  })())
  const door = src('src/services/providers/providerUsage.ts')
  check('by source: the driver subscribes the sign-in ledger\'s epoch and asks with the sign-in reason — no second signal', door.includes('subscribeSignInEpoch(() => {') && door.includes("reason: 'sign-in'") && !door.includes('subscribeAccountChange'))
  removeSignIn()
  seedSubscriber(Date.now() + 7 * 24 * 3600 * 1000)
  auth.dropCredentialMemos()
}

await api.close()
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-freshness${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
