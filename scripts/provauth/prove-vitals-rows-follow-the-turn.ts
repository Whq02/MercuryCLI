#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-vitals-rows-follow-the-turn')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
delete process.env.MERCURY_HOME
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_USAGE_SEED']) delete process.env[key]

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const limits = await import('../../src/services/anthropicLimits.js')
const owner = await import('../../src/services/providers/providerUsage.js')
const fresh = await import('../../src/services/providers/usageFreshness.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const auth = await import('../../src/utils/auth.js')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.js')
const { storeOAuthAccountInfo } = await import('../../src/services/oauth/client.js')
storeOAuthAccountInfo({ accountUuid: '00000000-0000-4000-8000-0000000000dd', emailAddress: 'vitals@example.com' })
const saved = auth.saveOAuthTokensIfNeeded({
  accessToken: 'fixture-access-token-vitals',
  refreshToken: 'fixture-refresh-token-vitals',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
})
if (!saved.success) throw new Error(`the credential store refused the sign-in: ${saved.warning ?? '?'}`)
auth.clearOAuthTokenCache()
recordSignIn('anthropic', 'oauth')

const MINUTE = 60_000
const relayed = typeof limits.anthropicObservedUsage === 'function' && typeof limits.adoptAnthropicObservedUsage === 'function'
const views = (): { fiveHour: ReturnType<typeof owner.anthropicWindowViews>[number]; sevenDay: ReturnType<typeof owner.anthropicWindowViews>[number] } => {
  const [fiveHour, sevenDay] = owner.anthropicWindowViews()
  return { fiveHour: fiveHour!, sevenDay: sevenDay! }
}
const tails = (now: number): string => {
  const v = views()
  return `5h ${fresh.usageAgeTail(v.fiveHour, now) ?? '—'} · 7d ${fresh.usageAgeTail(v.sevenDay, now) ?? '—'}`
}
const headersAt = (fivePct: number, weekPct: number, resetsAtS: number): Headers =>
  new Headers({
    'anthropic-ratelimit-unified-5h-utilization': String(fivePct / 100),
    'anthropic-ratelimit-unified-5h-reset': String(resetsAtS),
    'anthropic-ratelimit-unified-7d-utilization': String(weekPct / 100),
    'anthropic-ratelimit-unified-7d-reset': String(resetsAtS),
    'anthropic-ratelimit-unified-status': 'allowed',
  })

section('§1 the runner: a reply\'s headers stamp the record now, and the fact names the windows with their stamps')
limits.resetLimitsForCredentialSwitch()
const runnerNow = Date.now()
const resetsAtS = Math.floor(runnerNow / 1000) + 3_600
limits.extractQuotaStatusFromHeaders(headersAt(42, 18, resetsAtS), runnerNow)
const fact = relayed ? limits.anthropicObservedUsage() : undefined
check('the relay seam exists (anthropicObservedUsage · adoptAnthropicObservedUsage)', relayed)
check('the fact carries the owner and both windows as the headers stated them', fact !== undefined && fact.owner !== '' && fact.fiveHour?.utilization === 0.42 && fact.sevenDay?.utilization === 0.18 && fact.fiveHour.resetsAt === resetsAtS, JSON.stringify(fact))
check('each window is stamped with the reply\'s own time', fact !== undefined && fact.fiveHour !== undefined && fact.sevenDay !== undefined && fact.fiveHour.observedAtMs >= runnerNow && fact.sevenDay.observedAtMs >= runnerNow, JSON.stringify(fact))
const liveTails = tails(Date.now())
check('the runner\'s own rows read live', /^5h ↻\ds · 7d ↻\ds$/.test(liveTails), liveTails)

section('§2 the screen: its own record is fifteen minutes old (the endpoint read of the open) and reads stale')
const screenNow = Date.now()
const old = screenNow - 15 * MINUTE
limits.__setRawUtilizationForTest({
  five_hour: { utilization: 0.2, resets_at: resetsAtS, source: 'headers', observedAtMs: old },
  seven_day: { utilization: 0.1, resets_at: resetsAtS, source: 'headers', observedAtMs: old },
})
const staleTails = tails(screenNow)
check('the rows read "stale ↻15m" (the owner\'s field still)', staleTails === '5h stale ↻15m · 7d stale ↻15m', staleTails)
check('the stale verdict is the freshness owner\'s', owner.usageViewIsStale(views().fiveHour, screenNow) && owner.usageViewIsStale(views().sevenDay, screenNow))

section('§3 the turn\'s receipt reaches the screen: the facts carry the runner\'s record and the rows follow')
const adopted = relayed && fact !== undefined ? limits.adoptAnthropicObservedUsage(fact) : false
check('the screen adopts the runner\'s fact', adopted)
const movedTails = tails(screenNow)
check('the rows now read the reply\'s age, not the open\'s', /^5h ↻\ds · 7d ↻\ds$/.test(movedTails), movedTails)
check('the percentages are the reply\'s (42% · 18%), the stamp the reply\'s time', Math.round(views().fiveHour.usedPct ?? -1) === 42 && Math.round(views().sevenDay.usedPct ?? -1) === 18 && views().fiveHour.observedAtMs === fact?.fiveHour?.observedAtMs, JSON.stringify(views()))
check('no window reads stale any more', !owner.usageViewIsStale(views().fiveHour, screenNow) && !owner.usageViewIsStale(views().sevenDay, screenNow))

section('§4 the laws of adoption: by recency, by owner, by shape')
const again = relayed && fact !== undefined ? limits.adoptAnthropicObservedUsage(fact) : true
check('the same fact twice moves nothing', again === false)
const older = fact === undefined ? undefined : { ...fact, fiveHour: { ...fact.fiveHour!, utilization: 0.9, observedAtMs: fact.fiveHour!.observedAtMs - MINUTE } }
const olderAdopted = relayed && older !== undefined ? limits.adoptAnthropicObservedUsage(older) : true
check('an older observation never overwrites a fresher one', olderAdopted === false && Math.round(views().fiveHour.usedPct ?? -1) === 42)
const stranger = fact === undefined ? undefined : { ...fact, owner: 'someone-else@example.com', fiveHour: { ...fact.fiveHour!, utilization: 0.99, observedAtMs: Date.now() + MINUTE } }
const strangerAdopted = relayed && stranger !== undefined ? limits.adoptAnthropicObservedUsage(stranger) : true
check('a fact stamped for another account is refused', strangerAdopted === false && Math.round(views().fiveHour.usedPct ?? -1) === 42)
const shapes: unknown[] = [null, 'x', 7, [], {}, { owner: '' }, { owner: fact?.owner, fiveHour: { utilization: 'a', resetsAt: 1, observedAtMs: 1 } }, { owner: fact?.owner, fiveHour: { utilization: 0.5, resetsAt: -1, observedAtMs: Date.now() } }]
check('a malformed fact is refused without touching the record', relayed && shapes.every(shape => limits.adoptAnthropicObservedUsage(shape) === false) && Math.round(views().fiveHour.usedPct ?? -1) === 42)
const fresher = fact === undefined ? undefined : { owner: fact.owner, sevenDay: { utilization: 0.25, resetsAt: resetsAtS, observedAtMs: Date.now() + 2 * MINUTE } }
const fresherAdopted = relayed && fresher !== undefined ? limits.adoptAnthropicObservedUsage(fresher) : false
check('a fresher window moves on its own while the other stands', fresherAdopted && Math.round(views().sevenDay.usedPct ?? -1) === 25 && Math.round(views().fiveHour.usedPct ?? -1) === 42, JSON.stringify(views()))
limits.resetLimitsForCredentialSwitch()
check('after a credential switch nothing of the record is relayed', limits.anthropicObservedUsage?.() === undefined)

section('§5 the seam: the runner relays the record in its facts, the connector adopts it, the rail paints the age tail of the record it reads')
{
  const run = readFileSync(join(REPO, 'src/cli/run.ts'), 'utf8')
  const connector = readFileSync(join(REPO, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const types = readFileSync(join(REPO, 'src/services/engine-connector/types.ts'), 'utf8')
  const rail = readFileSync(join(REPO, 'src/utils/cockpit/helmVitalsModel.ts'), 'utf8')
  const seat = readFileSync(join(REPO, 'src/daemon/sessionSeat.ts'), 'utf8')
  check('the facts answer carries anthropicObserved beside the window verdict', run.includes('const anthropicObserved = anthropicObservedUsage()') && run.includes('...(anthropicObserved !== undefined ? { anthropicObserved } : {}),'))
  check('the connector adopts it with the window verdict', connector.includes('adoptAnthropicObservedUsage(next.usage?.anthropicObserved)'))
  check('the usage facts type names it', types.includes('anthropicObserved?: AnthropicObservedUsageV1'))
  check('the rail\'s meter tail is the freshness owner\'s age tail over the record', rail.includes('const age = usageAgeTail(w, readNow)') && rail.includes('usageViewIsStale(w, readNow)'))
  check('the seat re-asks the facts on assistant frames (the turn\'s receipt is the cadence, no clock added)', seat.includes('export function requestSessionFacts(') && seat.includes('setTimeout(fire, FACTS_DEBOUNCE_MS)') && /case 'step': \{[\s\S]*?requestSessionFacts\(short, roster, undefined, dir\)/.test(seat))
}

await releaseScratchHome(HOME)
console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? '✅ prove-vitals-rows-follow-the-turn: the rail follows the session\'s own replies' : `❌ prove-vitals-rows-follow-the-turn: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
