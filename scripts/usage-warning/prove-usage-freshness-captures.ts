#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const SHOT_DIR = process.env.USAGE_FRESH_SHOT_DIR
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
const LEGS = new Set((process.env.USAGE_FRESH_LEGS ?? 'a,b,c,e,f').split(',').map(s => s.trim()).filter(Boolean))

const { resolveCaptureDriver, captureEngineEntry } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}
const ENGINE = captureEngineEntry(driver, ROOT)

const POLL_MS = 5_000
const TICK_MS = 200
const ticks = (ms: number): number => Math.ceil(ms / TICK_MS)

type Send = Record<string, unknown>
interface Capture {
  text: string
  marks: Record<string, string>
  sends: number
  receipts: number
  tail: string
}

async function capture(tag: string, cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), `usage-fresh-shot-${tag}-`))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const tail = await new Promise<string>(resolveRun => {
    let out = ''
    const child = spawn(driver.python, [ENGINE, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', d => (out = (out + String(d)).slice(-600)))
    child.stderr.on('data', d => (out = (out + String(d)).slice(-600)))
    child.on('close', () => resolveRun(out))
  })
  type Grid = Array<Array<{ c?: string }>>
  let payload: { grid?: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }> } = {}
  try {
    payload = JSON.parse(readFileSync(outPath, 'utf8')) as typeof payload
  } catch {
  }
  const gridText = (grid: Grid | undefined): string =>
    (grid ?? [])
      .map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
      .join('\n')
  const text = gridText(payload.grid)
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  if (SHOT_DIR) {
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(SHOT_DIR, `${tag}.${label}.txt`), frame + '\n')
    writeFileSync(join(SHOT_DIR, `${tag}.final.txt`), text + '\n')
  }
  return {
    text,
    marks,
    sends: Array.isArray(cfg.sends) ? (cfg.sends as unknown[]).length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
    tail,
  }
}

function seedHome(): { home: string; workspace: string } {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'usage-fresh-home-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    join(home, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }))
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    }),
  )
  return { home, workspace }
}

function baseEnv(home: string, apiUrl: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    ANTHROPIC_BASE_URL: apiUrl,
    BROWSER: 'true',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    MERCURY_MOCK_LIMITS: '',
    MERCURY_MOCK_USAGE_PAYLOAD: '',
    MERCURY_USAGE_POLL_MS: String(POLL_MS),
  }
}

function reapHome(home: string): void {
  try {
    for (const rec of Object.values(readSessionWorkers(join(home, 'daemon')))) {
      if (rec.pid !== undefined) {
        try {
          process.kill(rec.pid, 'SIGTERM')
        } catch {
        }
      }
    }
  } catch {
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
  }
}

const hoursOn = (h: number): string => new Date(Date.now() + h * 3600e3).toISOString()
const risingPayload = (n: number): unknown => ({
  five_hour: { utilization: 26 + 10 * n, resets_at: hoursOn(2) },
  seven_day: { utilization: 44, resets_at: hoursOn(6 * 24) },
  seven_day_opus: { utilization: 61, resets_at: hoursOn(22) },
})

const FACE_THEN_CHAT: Send[] = [
  { data: '\r', atTick: 999, awaitText: 'New Session', requireAwait: true, minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3 },
]
const usageThenBack = (tabNeedle: string): Send[] => [
  { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\x1b', atTick: 999, awaitText: tabNeedle, requireAwait: true, minTick: 4, awaitSettleTicks: 2 },
  { data: '', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: 'after-usage' },
]
const markAfter = (label: string, ms: number): Send => ({ afterPrevTicks: ticks(ms), data: '', mark: label })

const BAR = '[█░▰▱]{2,4}'
const AGE = '↻\\d+[smhd]'
const rowOf = (frame: string, re: RegExp): string | undefined => frame.split('\n').map(l => l.replace(/\s+/g, ' ')).find(l => re.test(l))
const fiveHourPct = (frame: string): number | undefined => {
  const m = new RegExp(`5h ${BAR} (\\d+)%`).exec(frame.replace(/\s+/g, ' '))
  return m ? Number(m[1]) : undefined
}
const usageBlock = (frame: string): string => {
  const lines = frame.split('\n').map(l => l.replace(/\s+/g, ' ').trim())
  const start = lines.findIndex(l => /USAGE/.test(l))
  return start === -1 ? '(no USAGE panel)' : lines.slice(start, start + 9).join(' | ')
}

const RAIL = { cols: 160, rows: 45 }
function checkLiveAge(label: string, frame: string): void {
  const row = rowOf(frame, new RegExp(`5h ${BAR} \\d+%`))
  const m = row !== undefined ? new RegExp(`(${AGE})`).exec(row) : null
  const age = m ? m[1]! : undefined
  const seconds = age !== undefined && /s$/.test(age) ? Number(age.slice(1, -1)) : undefined
  check(`${label}: the 5h row names its age, younger than the TTL (${age ?? 'no age word'})`, seconds !== undefined && seconds <= POLL_MS / 1000 && !/stale/.test(row ?? ''), row ?? usageBlock(frame))
}

console.log('============================================================')
console.log(' usage freshness captures — the figure moves, ages, and a failed read speaks')
console.log('============================================================')

if (LEGS.has('a')) {
  const { home, workspace } = seedHome()
  const resetEpoch = Math.floor(Date.now() / 1000) + 2 * 3600
  const api = await startFixtureApi(
    Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })),
    {
      jsonForNonStream: true,
      messageHeaders: {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.11',
        'anthropic-ratelimit-unified-5h-reset': String(resetEpoch),
        'anthropic-ratelimit-unified-7d-utilization': '0.22',
        'anthropic-ratelimit-unified-7d-reset': String(resetEpoch + 5 * 24 * 3600),
      },
    },
  )
  api.usage.payload = risingPayload
  const t0 = Date.now()
  const c = await capture(
    'rail-cadence',
    {
      ...RAIL,
      total: 420,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        { data: '', atTick: 999, awaitText: 'USAGE', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'before-usage' },
        ...usageThenBack('Current session'),
        markAfter('poll1', POLL_MS + 1_500),
        markAfter('poll2', POLL_MS),
        markAfter('poll3', POLL_MS),
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    baseEnv(home, api.url),
  )
  const usageAsks = api.usageRequests.map(r => `#${r.n}@${((r.at - t0) / 1000).toFixed(1)}s:${r.mode}`)
  await api.close()
  reapHome(home)
  console.log('\nA + D · the rail at 160 cols — the cadence over a header observation')
  console.log(`  [FIXTURE] usage requests: ${usageAsks.join(' ') || 'none'}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const before = c.marks['before-usage'] ?? ''
  check("D: before /usage the rail paints the probe's header-fed windows (5h 11%) or the mount's first answer (36%)", fiveHourPct(before) === 11 || fiveHourPct(before) === 36, usageBlock(before))
  const after = c.marks['after-usage'] ?? ''
  check(`D: after the /usage mount the endpoint's FRESHER answer wins the row (5h ${fiveHourPct(after)}% ≥ 36, never the 11% headers)`, (fiveHourPct(after) ?? 0) >= 36, usageBlock(after))
  checkLiveAge('D: after the mount', after)
  const p1 = fiveHourPct(c.marks.poll1 ?? '')
  const p2 = fiveHourPct(c.marks.poll2 ?? '')
  const p3 = fiveHourPct(c.marks.poll3 ?? '')
  check(`A: the poll asked the endpoint at least three times after the tab's ask (${api.usageRequests.length} requests)`, api.usageRequests.length >= 5, usageAsks.join(' '))
  check(`A: the figure MOVES on the cadence (${fiveHourPct(after)} → ${p1} → ${p2} → ${p3})`, p1 !== undefined && p3 !== undefined && p3 > (fiveHourPct(after) ?? 0) && p3 >= (p1 ?? 0) && p3 >= (p2 ?? 0), [c.marks.poll1, c.marks.poll2, c.marks.poll3].map(f => usageBlock(f ?? '')).join('\n'))
  for (const label of ['poll1', 'poll2', 'poll3']) checkLiveAge(`A: ${label}`, c.marks[label] ?? '')
  check('A: the week and the pool ride the same answer (7d 44% · Opus 61%)', new RegExp(`7d ${BAR} 44%`).test(c.marks.poll3?.replace(/\s+/g, ' ') ?? '') && new RegExp(`Opus ${BAR} 61%`).test(c.marks.poll3?.replace(/\s+/g, ' ') ?? ''), usageBlock(c.marks.poll3 ?? ''))
  check('A: nothing reads stale while the poll answers', !/stale/.test(c.marks.poll3 ?? ''), usageBlock(c.marks.poll3 ?? ''))
}

if (LEGS.has('b')) {
  const { home, workspace } = seedHome()
  const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })), { jsonForNonStream: true })
  api.usage.mode = 'error'
  api.usage.status = 500
  api.usage.payload = risingPayload
  api.usage.next = n => {
    if (n >= 3) api.usage.mode = 'ok'
  }
  const t0 = Date.now()
  const backoffMs = 4 * POLL_MS
  const c = await capture(
    'rail-outage',
    {
      ...RAIL,
      total: 480,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        ...usageThenBack('500'),
        markAfter('inside-backoff', backoffMs / 2),
        markAfter('after-backoff', backoffMs / 2 + 2 * POLL_MS + 4_000),
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    baseEnv(home, api.url),
  )
  const asks = api.usageRequests.map(r => ({ ...r, s: (r.at - t0) / 1000 }))
  await api.close()
  reapHome(home)
  console.log('\nB · the rail at 160 cols — the outage')
  console.log(`  [FIXTURE] usage requests: ${asks.map(r => `#${r.n}@${r.s.toFixed(1)}s:${r.mode}`).join(' ') || 'none'}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const after = c.marks['after-usage'] ?? ''
  const noteRe = /read failed · HTTP 500/
  check('B: after the failed asks the rail says the read failed, with the status', noteRe.test(after.replace(/\s+/g, ' ')), usageBlock(after))
  check('B: …and paints no figure it never read (no usage read, never 0%)', /no usage read/.test(after) && !new RegExp(`5h ${BAR} \\d+%`).test(after.replace(/\s+/g, ' ')), usageBlock(after))
  const inside = c.marks['inside-backoff'] ?? ''
  check('B: inside the backoff the note stands and nothing else moved', noteRe.test(inside.replace(/\s+/g, ' ')), usageBlock(inside))
  const lastFailed = asks.filter(r => r.mode === 'error').at(-1)
  const retry = asks.find(r => r.mode === 'ok')
  check(`B: the operator's own ask (the tab) is never refused — it met the 500 too (${asks.filter(r => r.mode === 'error').length} failed asks)`, asks.filter(r => r.mode === 'error').length === 2, asks.map(r => `#${r.n}@${r.s.toFixed(1)}s:${r.mode}`).join(' '))
  check(`B: no request lands inside the backoff (4 × TTL = ${backoffMs / 1000} s): the retry came ${retry !== undefined && lastFailed !== undefined ? (retry.s - lastFailed.s).toFixed(1) : '(never)'} s after the last failure`, lastFailed !== undefined && retry !== undefined && retry.s - lastFailed.s >= (backoffMs / 1000) * 0.9, asks.map(r => `#${r.n}@${r.s.toFixed(1)}s:${r.mode}`).join(' '))
  const recovered = c.marks['after-backoff'] ?? ''
  check(`B: the retry after the backoff succeeds and the figure paints (5h ${fiveHourPct(recovered) ?? '—'}%)`, (fiveHourPct(recovered) ?? 0) > 0, usageBlock(recovered))
  check('B: …and the failure note is gone', !/read failed/.test(recovered), usageBlock(recovered))
  const record = join(home, 'usage-reader.json')
  let recorded: { families?: Record<string, { host?: string; status?: number; recoveredAtMs?: number }> } = {}
  try {
    recorded = JSON.parse(readFileSync(record, 'utf8')) as typeof recorded
  } catch {
  }
  const fam = recorded.families?.anthropic
  check("B: the doctor's record in the config home names the status and the host, and the recovery", fam?.status === 500 && typeof fam.host === 'string' && fam.host.includes('127.0.0.1') && typeof fam.recoveredAtMs === 'number', existsSync(record) ? readFileSync(record, 'utf8').slice(0, 300) : 'usage-reader.json absent')
}

if (LEGS.has('c')) {
  const { home, workspace } = seedHome()
  const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })), { jsonForNonStream: true })
  api.usage.payload = risingPayload
  api.usage.next = n => {
    if (n >= 2) api.usage.mode = 'hang'
  }
  const t0 = Date.now()
  const staleAfterMs = 2 * POLL_MS
  const c = await capture(
    'rail-freeze',
    {
      ...RAIL,
      total: 420,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        ...usageThenBack('Current session'),
        markAfter('young', POLL_MS + 2_000),
        markAfter('stale', staleAfterMs + 4_000),
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    baseEnv(home, api.url),
  )
  const asks = api.usageRequests.map(r => `#${r.n}@${((r.at - t0) / 1000).toFixed(1)}s:${r.mode}`)
  await api.close()
  reapHome(home)
  console.log('\nC · the rail at 160 cols — the freeze')
  console.log(`  [FIXTURE] usage requests: ${asks.join(' ') || 'none'}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const young = c.marks.young ?? ''
  const youngRow = rowOf(young, new RegExp(`5h ${BAR} 36%`))
  check('C: the mount\'s figure stands with its age while the first poll hangs (5h 36% ↻Ns, not yet stale)', youngRow !== undefined && new RegExp(AGE).test(youngRow) && !/stale/.test(youngRow), youngRow ?? usageBlock(young))
  const stale = c.marks.stale ?? ''
  const staleRow = rowOf(stale, new RegExp(`5h ${BAR} 36%`))
  check(`C: past 2 × TTL the same figure reads STALE with its age (${staleRow?.match(new RegExp(`stale ${AGE}`))?.[0] ?? 'no stale word'})`, staleRow !== undefined && new RegExp(`stale ${AGE}`).test(staleRow), staleRow ?? usageBlock(stale))
  check('C: the note names the timeout', /read failed · timeout/.test(stale.replace(/\s+/g, ' ')), usageBlock(stale))
  check('C: the figure itself is never blanked — the last observation stands beside the note', fiveHourPct(stale) === 36, usageBlock(stale))
}

if (LEGS.has('e')) {
  const { home, workspace } = seedHome()
  const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })), { jsonForNonStream: true })
  api.usage.payload = risingPayload
  const c = await capture(
    'band-cadence',
    {
      cols: 120,
      rows: 40,
      total: 360,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        ...usageThenBack('Current session'),
        markAfter('poll1', POLL_MS + 1_500),
        markAfter('poll2', POLL_MS),
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    {
      ...baseEnv(home, api.url),
      MERCURY_HELM_HOME: '0',
      MERCURY_SUBSTRATE: '0',
    },
  )
  await api.close()
  reapHome(home)
  console.log('\nE · the band at 120 cols')
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const after = (c.marks['after-usage'] ?? '').replace(/\s+/g, ' ')
  const afterChip = new RegExp(`5h ${BAR} (\\d+)%`).exec(after)
  check(`E: the band paints the endpoint's figure with its age tail (5h ${afterChip?.[1] ?? '?'}% ≥ 36 … ↻Ns)`, afterChip !== null && Number(afterChip[1]) >= 36 && new RegExp(`5h ${BAR} \\d+%.*${AGE}`).test(after), after.slice(-300))
  const p2 = (c.marks.poll2 ?? '').replace(/\s+/g, ' ')
  const moved = new RegExp(`5h ${BAR} (\\d+)%`).exec(p2)
  check(`E: the band's chip moves on the cadence (5h ${moved?.[1] ?? '?'}% > ${afterChip?.[1] ?? '?'}) and stays young`, moved !== null && afterChip !== null && Number(moved[1]) > Number(afterChip[1]) && new RegExp(AGE).test(p2) && !/stale/.test(p2), p2.slice(-300))
}

if (LEGS.has('f')) {
  const { home, workspace } = seedHome()
  const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })), { jsonForNonStream: true })
  api.usage.payload = risingPayload
  const RETRY_AFTER_S = 240
  api.usage.rateLimit = { limit: 1, windowMs: 180_000, retryAfterS: RETRY_AFTER_S }
  const debugFile = join(home, 'usage-read.debug.log')
  const t0 = Date.now()
  const c = await capture(
    'rail-wait',
    {
      ...RAIL,
      total: 460,
      argv: ['node', DIST, '--debug-file', debugFile],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        { data: '', atTick: 999, awaitText: 'USAGE', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'boot' },
        { data: '', atTick: 999, awaitText: 'HTTP 429', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'rail' },
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '', atTick: 999, awaitText: 'asked us to wait', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'tab' },
        { data: '\x1b', atTick: 999, awaitText: 'asked us to wait', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
        { data: '', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'after-usage' },
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    baseEnv(home, api.url),
  )
  const asks = api.usageRequests.map(r => ({ ...r, s: (r.at - t0) / 1000 }))
  await api.close()
  reapHome(home)
  const readLines = existsSync(debugFile) ? readFileSync(debugFile, 'utf8').split('\n').filter(l => l.includes('[usage] read #')) : []
  console.log('\nF · the rail at 160 cols — a 429 with Retry-After is a WAIT on screen')
  console.log(`  [FIXTURE] usage requests: ${asks.map(r => `#${r.n}@${r.s.toFixed(1)}s:${r.status}`).join(' ') || 'none'}`)
  console.log(`  [DEBUG] ${readLines.length} read line(s):`)
  for (const line of readLines) console.log(`    ${line.replace(/^\S+ \[DEBUG\] /, '')}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const first = asks[0]
  check("the request's identity headers are the release's shape (User-Agent mercury/<version> · Authorization Bearer · anthropic-beta oauth-2025-04-20 · Content-Type application/json)", first !== undefined && /^mercury\/\d+\.\d+\.\d+/.test(first.headers['user-agent'] ?? '') && first.headers.authScheme === 'Bearer' && first.headers['anthropic-beta'] === 'oauth-2025-04-20' && first.headers['content-type'] === 'application/json', JSON.stringify(first?.headers))
  check('every read leaves one debug line naming its reason and the host', readLines.length === asks.length && readLines.every(l => /\((poll|turn|operator|sign-in)\) GET 127\.0\.0\.1:\d+\/api\/oauth\/usage → /.test(l)), `${readLines.length} line(s) for ${asks.length} request(s)`)
  check('the mount read is admitted (200) and the figure paints (5h ≥ 36%)', asks[0]?.status === 200 && (fiveHourPct(c.marks.boot ?? '') ?? 0) >= 36, `#1:${asks[0]?.status} · ${usageBlock(c.marks.boot ?? '')}`)
  const refused = asks.find(r => r.status === 429)
  check(`the next read trips the limiter: 429 with Retry-After ${RETRY_AFTER_S} s`, refused !== undefined && readLines.some(l => /HTTP 429 · retry-after 240 s/.test(l)), asks.map(r => `#${r.n}:${r.status}`).join(' '))
  const tab = c.marks.tab ?? ''
  check("the tab says 'the usage endpoint asked us to wait … (HTTP 429, host)' — the wording, the 429 and the host — never 'Failed to load'", /the usage endpoint asked us to wait/.test(tab) && /HTTP 429/.test(tab) && /127\.0\.0\.1:\d+/.test(tab) && !/Failed to load/.test(tab), tab.split('\n').filter(l => /wait|HTTP 429|Anthropic usage/.test(l)).join(' | ').slice(0, 400))
  const rail = (c.marks.rail ?? '').replace(/\s+/g, ' ')
  check("the rail's compact note says 'wait 4m · HTTP 429' — never 'read failed'", /wait 4m · HTTP 429/.test(rail) && !/read failed/.test(rail), usageBlock(c.marks.rail ?? ''))
  const afterRefused = refused !== undefined ? asks.filter(r => r.s > refused.s) : []
  check(`inside the server's wait no read re-trips the endpoint (${afterRefused.length} read(s) after the 429, in a ${((Date.now() - t0) / 1000).toFixed(0)} s drive « ${RETRY_AFTER_S} s)`, afterRefused.length === 0, asks.map(r => `#${r.n}@${r.s.toFixed(1)}s:${r.status}`).join(' '))
  const held = c.marks['after-usage'] ?? ''
  check('…and the figure still stands beside the wait note (5h ≥ 36%, never blanked)', (fiveHourPct(held) ?? 0) >= 36 && /wait 4m · HTTP 429/.test(held.replace(/\s+/g, ' ')), usageBlock(held))
  const record = join(home, 'usage-reader.json')
  let recorded: { families?: Record<string, { status?: number; retryAfterMs?: number; recoveredAtMs?: number }> } = {}
  try {
    recorded = JSON.parse(readFileSync(record, 'utf8')) as typeof recorded
  } catch {
  }
  const fam = recorded.families?.anthropic
  check("the doctor's record names the 429 and the stated wait (Retry-After 240 s)", fam?.status === 429 && fam.retryAfterMs === RETRY_AFTER_S * 1000, existsSync(record) ? readFileSync(record, 'utf8').slice(0, 400) : 'usage-reader.json absent')
}

console.log(failures === 0 ? '\n✅ prove-usage-freshness-captures — all checks pass' : `\n❌ prove-usage-freshness-captures — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
