#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-zai-quota-door-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_AUTH_SCOPE_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const name of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_LOCAL_BASE_URL']) process.env[name] = 'http://127.0.0.1:1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const KEY = 'zai-fixture-coding-key'
const QUOTA_PATH = '/api/monitor/usage/quota/limit'
const T0 = 1_790_000_000_000
let now = T0
const capture = (fiveHourReset: number, weekReset: number) => ({
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 2040, remaining: 9960, percentage: 17, nextResetTime: fiveHourReset },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 1800, remaining: 58200, percentage: 3, nextResetTime: weekReset },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 2, remaining: 998, percentage: 0, nextResetTime: weekReset + 20 * 86_400_000, usageDetails: [{ modelCode: 'web-reader', usage: 2 }] },
    ],
    level: 'pro',
  },
  success: true,
})
type Mode = 'both' | 'bearer-only' | 'raw-only' | 'bearer-only-http' | 'expired' | 'no-plan' | 'http-503' | 'garbage'
let mode: Mode = 'both'
const wire: Array<{ path: string; authorization: string | null; accept: string | null; language: string | null; agent: string | null }> = []
const escaped: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    const authorization = request.headers.get('authorization')
    wire.push({ path, authorization, accept: request.headers.get('accept'), language: request.headers.get('accept-language'), agent: request.headers.get('user-agent') })
    if (request.method !== 'GET' || path !== QUOTA_PATH) return new Response(null, { status: 404 })
    const raw = authorization === KEY
    const bearer = authorization === `Bearer ${KEY}`
    if (!raw && !bearer) return Response.json({ code: 1001, msg: 'Authorization Token Missing', success: false })
    if (mode === 'bearer-only' && raw) return Response.json({ code: 1001, msg: 'Authorization Token Missing', success: false })
    if (mode === 'raw-only' && bearer) return Response.json({ code: 1000, msg: 'Authentication failed', success: false })
    if (mode === 'bearer-only-http' && raw) return new Response('unauthorized', { status: 401 })
    if (mode === 'expired') return Response.json({ code: 1309, msg: 'The coding plan has expired', success: false })
    if (mode === 'no-plan') return Response.json({ code: 1234, msg: 'The current user has no coding plan', success: false })
    if (mode === 'http-503') return new Response('busy', { status: 503 })
    if (mode === 'garbage') return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    return Response.json(capture(now + 2 * 3_600_000, now + 6 * 86_400_000))
  },
})
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_ZAI_API_BASE = `${base}/coding/paas/v4`
const realFetch = globalThis.fetch
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin === 'http://127.0.0.1:1') throw new Error('connection refused (the dead loopback port)')
  if (url.origin !== base) {
    escaped.push(url.origin)
    throw new Error(`only the quota fixture may be contacted (asked ${url.origin})`)
  }
  return realFetch(input, { ...init, redirect: 'error' })
}) as typeof fetch
const clock = () => now
const sinceWire = (from: number) => wire.slice(from).map(r => `${r.path} ${r.authorization === KEY ? 'raw' : r.authorization === `Bearer ${KEY}` ? 'bearer' : String(r.authorization)}`)

try {
  section('§0 the reader exists and the door has a Z.ai case')
  const readerPresent = existsSync(join(ROOT, 'src/services/providers/zai/zaiUsageState.ts'))
  check('the Z.ai quota reader exists (src/services/providers/zai/zaiUsageState.ts)', readerPresent, 'no such module on this tree')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const secrets = await import('../../src/utils/router/providerSecrets.ts')
  const owner = await import('../../src/services/providers/providerUsage.ts')
  const records = await import('../../src/services/anthropicLimits.ts')
  const fresh = await import('../../src/services/providers/usageFreshness.ts')
  secrets.writeStoredZaiApiKey(KEY, 'coding')
  const before = wire.length
  const versionBefore = records.getUsageRecordVersion()
  await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
  const first = owner.usageForProvider('zai')
  check('the door asks the quota endpoint once for a stored GLM Coding Plan key', wire.length === before + 1 && wire[before]?.path === QUOTA_PATH, `wire: ${JSON.stringify(sinceWire(before))} — the door made no quota request; nothing on this tree reads Z.ai usage`)
  check('the owner view carries the 5h and 7d windows with the stated percents', first.shape === 'subscription-windows' && first.windows.map(w => `${w.key}:${w.usedPct}`).join(',') === '5h:17,7d:3', `windows: ${JSON.stringify(first.windows)}; shape ${first.shape}; absence ${first.absence}`)
  check('each window carries its reset and the read stamp', first.windows.every(w => w.resetsAtMs !== undefined && w.observedAtMs === T0 && w.source === 'endpoint'), JSON.stringify(first.windows))
  check("the tier is the wire's level in the product's spelling", first.tier === 'GLM Coding Pro', first.tier)
  check('a confirmed answer raises the usage record signal (the rail repaints at once)', records.getUsageRecordVersion() > versionBefore)
  if (!readerPresent) throw new Error('base tree: no reader')
  const reader = await import(join(ROOT, 'src/services/providers/zai/zaiUsageState.ts')) as typeof import('../../src/services/providers/zai/zaiUsageState.ts')

  section('§1 the header law: the RAW key first, with the vendor headers')
  {
    const request = wire[before]!
    check('the first request sends the key raw in authorization (no Bearer prefix)', request.authorization === KEY, String(request.authorization))
    check('accept: application/json, accept-language: en-US,en, a user-agent', request.accept === 'application/json' && request.language === 'en-US,en' && typeof request.agent === 'string' && request.agent.length > 0, JSON.stringify(request))
    check("the remembered form is 'raw'", reader.zaiQuotaAuthForm() === 'raw', reader.zaiQuotaAuthForm())
    check('the production URL is the monitor path on the coding base origin', reader.zaiQuotaLimitUrl({}) === 'https://api.z.ai/api/monitor/usage/quota/limit', reader.zaiQuotaLimitUrl({}))
    check('the fixture URL follows MERCURY_ZAI_API_BASE to the loopback origin', reader.zaiQuotaLimitUrl(process.env) === `${base}${QUOTA_PATH}`, reader.zaiQuotaLimitUrl(process.env))
  }

  section("§2 the cadence: a shown meter inside the floor is served from the record; the floor, the operator's force and single-flight")
  {
    const from = wire.length
    now = T0 + 30_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, reason: 'open' })
    check('a re-show 30 s later makes no request (inside the 60 s floor)', wire.length === from, JSON.stringify(sinceWire(from)))
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('a forced ask reads again', wire.length === from + 1, JSON.stringify(sinceWire(from)))
    const stamped = owner.usageForProvider('zai').windows[0]?.observedAtMs
    check('the record now carries the later stamp', stamped === T0 + 30_000, String(stamped))
    now = T0 + 30_000 + fresh.usagePollTtlMs() + 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, reason: 'open' })
    check('past the floor a shown meter reads again', wire.length === from + 2, JSON.stringify(sinceWire(from)))
    const concurrent = wire.length
    await Promise.all([
      owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true }),
      owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true }),
      owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true }),
    ])
    check('three concurrent forced asks are one request (single-flight)', wire.length === concurrent + 1, JSON.stringify(sinceWire(concurrent)))
  }

  section('§3 the one Bearer retry on an auth code, and the answering form remembered')
  {
    mode = 'bearer-only'
    const from = wire.length
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('raw refused with code 1001 ⇒ exactly one retry as Bearer <key>', sinceWire(from).join(' | ') === `${QUOTA_PATH} raw | ${QUOTA_PATH} bearer`, JSON.stringify(sinceWire(from)))
    check('the retry confirmed: the record is fresh, no reader note', owner.usageForProvider('zai').windows[0]?.observedAtMs === now && owner.usageForProvider('zai').readerNote === undefined, JSON.stringify(owner.usageForProvider('zai').readerNote))
    check("the answering form is remembered: 'bearer'", reader.zaiQuotaAuthForm() === 'bearer', reader.zaiQuotaAuthForm())
    const next = wire.length
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('the next refresh sends Bearer first and needs no retry', sinceWire(next).join(' | ') === `${QUOTA_PATH} bearer`, JSON.stringify(sinceWire(next)))
    mode = 'raw-only'
    const back = wire.length
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('the law is symmetric: Bearer refused with code 1000 ⇒ one retry raw, and raw is remembered again', sinceWire(back).join(' | ') === `${QUOTA_PATH} bearer | ${QUOTA_PATH} raw` && reader.zaiQuotaAuthForm() === 'raw', JSON.stringify(sinceWire(back)))
    mode = 'bearer-only-http'
    const http = wire.length
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('an HTTP 401 on the raw form also earns the one Bearer retry', sinceWire(http).join(' | ') === `${QUOTA_PATH} raw | ${QUOTA_PATH} bearer` && reader.zaiQuotaAuthForm() === 'bearer', JSON.stringify(sinceWire(http)))
    mode = 'both'
    reader.__resetZaiUsageForTest()
    check('a reset forgets the form (raw first again)', reader.zaiQuotaAuthForm() === 'raw')
    const other = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('after the reset the door reads raw once', sinceWire(other).join(' | ') === `${QUOTA_PATH} raw`, JSON.stringify(sinceWire(other)))
    const keyChange = wire.length
    mode = 'bearer-only'
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check("the form is 'bearer' for this key", reader.zaiQuotaAuthForm() === 'bearer' && wire.length === keyChange + 2)
    secrets.writeStoredZaiApiKey('zai-fixture-second-key', 'coding')
    check('a new key forgets the record and the form (never another key\'s figure or form)', reader.zaiObservedQuota() === null && reader.zaiQuotaAuthForm() === 'raw' && owner.usageForProvider('zai').windows.length === 0, JSON.stringify(owner.usageForProvider('zai').windows))
    secrets.writeStoredZaiApiKey(KEY, 'coding')
    mode = 'both'
    reader.__resetZaiUsageForTest()
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('the fixture key reads again', owner.usageForProvider('zai').windows.length === 2)
  }

  section('§4 a refused or unreachable read leaves the last observation standing, with the reader\'s one line beside it')
  {
    const stamp = owner.usageForProvider('zai').windows[0]?.observedAtMs
    mode = 'expired'
    now += 1_000
    const from = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    const expired = owner.usageForProvider('zai')
    check('code 1309 is not an auth code: one request, no Bearer retry', wire.length === from + 1, JSON.stringify(sinceWire(from)))
    check('the last observation stands with its old stamp', expired.windows.length === 2 && expired.windows[0]?.observedAtMs === stamp, JSON.stringify(expired.windows))
    check("the reader's line: 'no usage read (1309 The coding plan has expired)' in prose and compact", expired.readerNote === 'no usage read (1309 The coding plan has expired)' && expired.readerNoteCompact === expired.readerNote, JSON.stringify(expired.readerNote))
    check('the last failure is kept in the state with its code and words', reader.zaiLastQuotaFailure()?.code === 1309 && reader.zaiLastQuotaFailure()?.message === 'The coding plan has expired' && reader.zaiLastQuotaFailure()?.atMs === now, JSON.stringify(reader.zaiLastQuotaFailure()))
    mode = 'http-503'
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check("an HTTP 503: 'no usage read (HTTP 503)', the record still standing", owner.usageForProvider('zai').readerNote === 'no usage read (HTTP 503)' && owner.usageForProvider('zai').windows.length === 2, JSON.stringify(owner.usageForProvider('zai').readerNote))
    mode = 'garbage'
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('an undecodable 200 is a refusal, never a wrong meter', owner.usageForProvider('zai').readerNote?.startsWith('no usage read (') === true && owner.usageForProvider('zai').windows[0]?.usedPct === 17, JSON.stringify(owner.usageForProvider('zai').readerNote))
    mode = 'both'
    now += 1_000
    const dead = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true, env: { ...process.env, MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1/coding/paas/v4' } })
    check("an unreachable base: no request on the fixture wire, 'no usage read (unreachable · …)', the record standing", wire.length === dead && owner.usageForProvider('zai').readerNote?.startsWith('no usage read (unreachable · ') === true && owner.usageForProvider('zai').windows.length === 2, JSON.stringify(owner.usageForProvider('zai').readerNote))
    now += 1_000
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('a good answer clears the line and refreshes the stamp', owner.usageForProvider('zai').readerNote === undefined && owner.usageForProvider('zai').windows[0]?.observedAtMs === now, JSON.stringify(owner.usageForProvider('zai').readerNote))
  }

  section("§5 a key with no coding plan: one honest line, no meter; a general or env key: the door asks nothing")
  {
    reader.__resetZaiUsageForTest()
    mode = 'no-plan'
    now += 1_000
    const from = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    const noPlan = owner.usageForProvider('zai')
    check('the no-plan msg is not an auth code: one request', wire.length === from + 1, JSON.stringify(sinceWire(from)))
    check("the view: api-spend, 'usage: not on a coding plan', no windows, no reader note", noPlan.shape === 'api-spend' && noPlan.absence === 'usage: not on a coding plan' && noPlan.windows.length === 0 && noPlan.readerNote === undefined, JSON.stringify({ shape: noPlan.shape, absence: noPlan.absence, note: noPlan.readerNote }))
    check("the summary words carry the one line", owner.usageSummaryWords(noPlan, now).includes('usage: not on a coding plan'), owner.usageSummaryWords(noPlan, now))
    mode = 'both'
    reader.__resetZaiUsageForTest()
    secrets.writeStoredZaiApiKey('zai-fixture-general-key')
    const general = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    const generalView = owner.usageForProvider('zai')
    check('a stored general key: the door asks nothing', wire.length === general, JSON.stringify(sinceWire(general)))
    check('its view is the api-spend shape with the one general line', generalView.shape === 'api-spend' && generalView.absence === 'No usage road for a general Z.AI key — https://z.ai/manage-apikey/billing is the view' && generalView.windows.length === 0, JSON.stringify(generalView.absence))
    secrets.writeStoredZaiApiKey(null)
    const envKey = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true, env: { ...process.env, ZAI_API_KEY: 'zai-env-fixture-key' } })
    check('an env key (no plan record) asks nothing', wire.length === envKey, JSON.stringify(sinceWire(envKey)))
    const none = wire.length
    await owner.refreshProviderUsage('zai', { fetchImpl, now: clock, force: true })
    check('no key asks nothing and the view is the why-not', wire.length === none && owner.usageForProvider('zai').sourceKind === 'none')
  }

  check('no request escaped the loopback fixture', escaped.length === 0, JSON.stringify(escaped))
} catch (error) {
  if (!(error instanceof Error && error.message === 'base tree: no reader')) {
    failures++
    console.log(`  [FAIL] the proof ran to its end — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
} finally {
  server.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\nzai quota door: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
