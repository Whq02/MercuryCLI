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
  markAt: Record<string, number>
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
  let payload: { grid?: Grid; sendReceipts?: Array<{ ts?: number }>; marks?: Array<{ label: string; grid: Grid }> } = {}
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
  const markAt: Record<string, number> = {}
  const sendList = Array.isArray(cfg.sends) ? (cfg.sends as Array<{ mark?: string }>) : []
  ;(payload.sendReceipts ?? []).forEach((receipt, i) => {
    const label = sendList[i]?.mark
    if (label !== undefined && typeof receipt.ts === 'number') markAt[label] = receipt.ts
  })
  if (SHOT_DIR) {
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(SHOT_DIR, `${tag}.${label}.txt`), frame + '\n')
    writeFileSync(join(SHOT_DIR, `${tag}.final.txt`), text + '\n')
  }
  return {
    text,
    marks,
    markAt,
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
const usageThenBack = (tabNeedle: string, mark = 'after-usage'): Send[] => [
  { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\x1b', atTick: 999, awaitText: tabNeedle, requireAwait: true, minTick: 4, awaitSettleTicks: 2 },
  { data: '', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark },
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
  check(`${label}: the 5h row names its age, younger than the floor (${age ?? 'no age word'})`, seconds !== undefined && seconds <= POLL_MS / 1000 && !/stale/.test(row ?? ''), row ?? usageBlock(frame))
}

console.log('============================================================')
console.log(' usage freshness captures — a shown meter reads once, ages in the open, reads again on retry, and a failed read speaks')
console.log('============================================================')

const retryInTab = (needle: string, mark: string): Send[] => [
  { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: 'r', atTick: 999, awaitText: needle, requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
  { data: '', afterPrevTicks: ticks(2_500), mark },
  { data: '\x1b', atTick: 999, awaitText: needle, requireAwait: true, minTick: 1, awaitSettleTicks: 1 },
  { data: '', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 2, mark: `${mark}-rail` },
]
const ageOf = (frame: string): string | undefined => {
  const row = rowOf(frame, new RegExp(`5h ${BAR} \\d+%`))
  return row !== undefined ? new RegExp(`(stale )?${AGE}`).exec(row)?.[0] : undefined
}

if (LEGS.has('a')) {
  const { home, workspace } = seedHome()
  const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })), { jsonForNonStream: true })
  api.usage.payload = risingPayload
  const t0 = Date.now()
  const c = await capture(
    'rail-on-show',
    {
      ...RAIL,
      total: 520,
      argv: ['node', DIST],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        { data: '', atTick: 999, awaitText: 'USAGE', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'before-usage' },
        ...usageThenBack('Current session'),
        markAfter('floor1', POLL_MS + 1_500),
        markAfter('floor2', POLL_MS),
        markAfter('floor3', POLL_MS),
        ...retryInTab('Current session', 'retried'),
      ],
      readyText: ['? for shortcuts'],
      stableTicks: 4,
    },
    baseEnv(home, api.url),
  )
  const usageAsks = api.usageRequests.map(r => `#${r.n}@${((r.at - t0) / 1000).toFixed(1)}s:${r.mode}`)
  await api.close()
  reapHome(home)
  console.log('\nA · the rail at 160 cols — the read on show, no clock, the retry')
  console.log(`  [FIXTURE] usage requests: ${usageAsks.join(' ') || 'none'}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const before = c.marks['before-usage'] ?? ''
  check("A: before /usage the rail paints the gauges' own first read (5h 36%) or says no usage read yet — never a fabricated figure", fiveHourPct(before) === 36 || /no usage read/.test(before), usageBlock(before))
  const after = c.marks['after-usage'] ?? ''
  const shown = fiveHourPct(after)
  check(`A: the tab's own ask is the second read and wins the row (5h ${shown ?? '—'}% = 46)`, shown === 46, usageBlock(after))
  checkLiveAge('A: after the tab', after)
  const f1 = fiveHourPct(c.marks.floor1 ?? '')
  const f2 = fiveHourPct(c.marks.floor2 ?? '')
  const f3 = fiveHourPct(c.marks.floor3 ?? '')
  check(`A: three floors later the row has NOT moved (${shown} → ${f1} → ${f2} → ${f3}): nothing reads on a clock`, f1 === shown && f2 === shown && f3 === shown, usageBlock(c.marks.floor3 ?? ''))
  const gapToRetry = api.usageRequests.length >= 3 ? (api.usageRequests[2]!.at - api.usageRequests[1]!.at) / 1000 : -1
  check(`A: the fixture saw exactly three reads — the mount's, the tab's, and the retry's more than three floors later (${api.usageRequests.length} reads, gap ${gapToRetry.toFixed(1)} s) — none on a clock`, api.usageRequests.length === 3 && gapToRetry > (3 * POLL_MS) / 1000, usageAsks.join(' '))
  check(`A: the age tail grows in the open and reads stale past 2 × floor (${ageOf(c.marks.floor3 ?? '') ?? 'no age word'})`, /^stale ↻/.test(ageOf(c.marks.floor3 ?? '') ?? ''), usageBlock(c.marks.floor3 ?? ''))
  const retried = fiveHourPct(c.marks['retried-rail'] ?? c.marks.retried ?? '')
  check(`A: the tab's retry reads again — the row moves (5h ${retried ?? '—'}% > ${shown})`, retried !== undefined && shown !== undefined && retried > shown, usageBlock(c.marks['retried-rail'] ?? ''))
  checkLiveAge('A: after the retry', c.marks['retried-rail'] ?? '')
  check('A: the week and the pool ride the same answer (7d 44% · Opus 61%)', new RegExp(`7d ${BAR} 44%`).test(c.marks['retried-rail']?.replace(/\s+/g, ' ') ?? '') && new RegExp(`Opus ${BAR} 61%`).test(c.marks['retried-rail']?.replace(/\s+/g, ' ') ?? ''), usageBlock(c.marks['retried-rail'] ?? ''))
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
  const debugFileB = join(home, 'usage-read.debug.log')
  const c = await capture(
    'rail-outage',
    {
      ...RAIL,
      total: 520,
      argv: ['node', DIST, '--debug-file', debugFileB],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        ...usageThenBack('500'),
        markAfter('inside-backoff', backoffMs / 2),
        markAfter('after-backoff', backoffMs / 2 + 2_000),
        ...usageThenBack('Current session', 'after-second-usage'),
        { data: '', afterPrevTicks: ticks(1_500), mark: 'recovered' },
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
  const readLinesB = existsSync(debugFileB) ? readFileSync(debugFileB, 'utf8').split('\n').filter(l => l.includes('[usage] read #')) : []
  console.log(`  [DEBUG] ${readLinesB.length} read line(s):`)
  for (const line of readLinesB) console.log(`    ${line.replace(/^\S+ \[DEBUG\] /, '')}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const after = c.marks['after-usage'] ?? ''
  const noteRe = /read failed · HTTP 500/
  check('B: after the failed asks the rail says the read failed, with the status', noteRe.test(after.replace(/\s+/g, ' ')), usageBlock(after))
  check('B: …and paints no figure it never read (no usage read, never 0%)', /no usage read/.test(after) && !new RegExp(`5h ${BAR} \\d+%`).test(after.replace(/\s+/g, ' ')), usageBlock(after))
  const inside = c.marks['inside-backoff'] ?? ''
  check('B: inside the backoff the note stands and nothing else moved', noteRe.test(inside.replace(/\s+/g, ' ')), usageBlock(inside))
  const failed = asks.filter(r => r.mode === 'error')
  check(`B: the mount's read and the tab's own ask both met the 500 (${failed.length} failed asks) — the operator's ask is never refused by the floor`, failed.length === 2, asks.map(r => `#${r.n}:${r.mode}`).join(' '))
  const lastFailed = failed.at(-1)
  const afterMark = c.marks['after-backoff'] ?? ''
  const landedByAfterBackoff = lastFailed !== undefined ? asks.filter(r => r.s > lastFailed.s && r.s < lastFailed.s + backoffMs / 1000 + 2).length : -1
  check(`B: no request lands inside the backoff (4 × floor = ${backoffMs / 1000} s) NOR after it on its own — nothing reads on a clock (${landedByAfterBackoff} landed)`, landedByAfterBackoff === 0 && noteRe.test(afterMark.replace(/\s+/g, ' ')), usageBlock(afterMark))
  const recovered = c.marks.recovered ?? ''
  const retry = asks.find(r => r.mode === 'ok')
  check(`B: the tab's ask after the backoff is admitted, succeeds and the figure paints (5h ${fiveHourPct(recovered) ?? '—'}%)`, retry !== undefined && (fiveHourPct(recovered) ?? 0) > 0, usageBlock(recovered))
  check('B: …and the failure note is gone', !/read failed/.test(recovered), usageBlock(recovered))
  const record = join(home, 'usage-reader.json')
  let recorded: { families?: Record<string, { host?: string; status?: number; recoveredAtMs?: number }> } = {}
  try {
    recorded = JSON.parse(readFileSync(record, 'utf8')) as typeof recorded
  } catch {
  }
  const fam = recorded.families?.anthropic
  check("B: the doctor's record in the config home names the status and the host, and the recovery", fam?.status === 500 && typeof fam.host === 'string' && fam.host.includes('127.0.0.1') && typeof fam.recoveredAtMs === 'number', existsSync(record) ? readFileSync(record, 'utf8').slice(0, 300) : 'no record')
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
        ...usageThenBack('Anthropic usage'),
        markAfter('young', POLL_MS),
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
  check("C: the mount's figure stands with its age while the tab's ask hangs (5h 36% ↻Ns, not yet stale)", youngRow !== undefined && new RegExp(AGE).test(youngRow) && !/stale/.test(youngRow), youngRow ?? usageBlock(young))
  const stale = c.marks.stale ?? ''
  const staleRow = rowOf(stale, new RegExp(`5h ${BAR} 36%`))
  check(`C: past 2 × floor the same figure reads STALE with its age (${staleRow?.match(new RegExp(`stale ${AGE}`))?.[0] ?? 'no stale word'}) — no request landed on its own`, staleRow !== undefined && new RegExp(`stale ${AGE}`).test(staleRow) && api.usageRequests.length === 2, `${api.usageRequests.length} request(s) · ${staleRow ?? usageBlock(stale)}`)
  check('C: the note names the timeout', /read failed · timeout/.test(stale.replace(/\s+/g, ' ')), usageBlock(stale))
  check('C: the figure itself is never blanked — the last observation stands beside the note', fiveHourPct(stale) === 36, usageBlock(stale))
}

if (LEGS.has('e')) {
  const { home, workspace } = seedHome()
  const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })), { jsonForNonStream: true })
  api.usage.payload = risingPayload
  const debugFileE = join(home, 'usage-read.debug.log')
  const t0 = Date.now()
  const c = await capture(
    'band-on-show',
    {
      cols: 120,
      rows: 40,
      total: 360,
      argv: ['node', DIST, '--debug-file', debugFileE],
      cwd: workspace,
      sends: [
        ...FACE_THEN_CHAT,
        ...usageThenBack('Current session'),
        markAfter('floor1', POLL_MS + 1_500),
        markAfter('floor2', POLL_MS),
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
  const asks = api.usageRequests.length
  const asksE = api.usageRequests.map(r => `#${r.n}@${((r.at - t0) / 1000).toFixed(1)}s:${r.mode}`)
  await api.close()
  reapHome(home)
  const readLinesE = existsSync(debugFileE) ? readFileSync(debugFileE, 'utf8').split('\n').filter(l => l.includes('[usage] read #')) : []
  console.log('\nE · the band at 120 cols')
  console.log(`  [FIXTURE] usage requests: ${asksE.join(' ') || 'none'}`)
  console.log(`  [DEBUG] ${readLinesE.length} read line(s):`)
  for (const line of readLinesE) console.log(`    ${line.replace(/^\S+ \[DEBUG\] /, '')}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const after = (c.marks['after-usage'] ?? '').replace(/\s+/g, ' ')
  const afterChip = new RegExp(`5h ${BAR} (\\d+)%`).exec(after)
  check(`E: the band paints the endpoint's figure with its age tail (5h ${afterChip?.[1] ?? '?'}% ≥ 36 … ↻Ns)`, afterChip !== null && Number(afterChip[1]) >= 36 && new RegExp(`5h ${BAR} \\d+%.*${AGE}`).test(after), after.slice(0, 200))
  const p2 = (c.marks.floor2 ?? '').replace(/\s+/g, ' ')
  const held = new RegExp(`5h ${BAR} (\\d+)%`).exec(p2)
  const readsE = readLinesE.map(l => l.replace(/^.*\[usage\] /, '')).join(' | ') || 'none'
  check(`E: the band's chip HOLDS its figure across two floors (5h ${held?.[1] ?? '?'}% = ${afterChip?.[1] ?? '?'}) and carries its age`, held !== null && afterChip !== null && Number(held[1]) === Number(afterChip[1]) && new RegExp(AGE).test(p2), `${p2.slice(0, 200)} · reads: ${readsE}`)
  const reasons = readLinesE.map(l => /read #\d+ \((open|operator|sign-in)\)/.exec(l)?.[1] ?? 'unnamed')
  const instants = api.usageRequests.map(r => r.at)
  const insideFloor = reasons
    .map((reason, i) => (reason === 'open' && i > 0 && instants[i] !== undefined && instants[i - 1] !== undefined ? instants[i]! - instants[i - 1]! : Number.POSITIVE_INFINITY))
    .filter(gap => gap < POLL_MS - 500)
  check(`E: every read names a lawful trigger and no open read lands inside the floor (${reasons.join(', ')})`, reasons.length === asks && reasons.every(r => r !== 'unnamed') && insideFloor.length === 0, readsE)
  const afterUsageAt = c.markAt['after-usage']
  const late = afterUsageAt !== undefined ? api.usageRequests.filter(r => r.at > afterUsageAt) : []
  check(`E: once the tab has closed nothing reads across two floors — no request after the after-usage mark (${asks} reads in all, ${late.length} after it)`, afterUsageAt !== undefined && late.length === 0, `mark at ${afterUsageAt} · asks ${asksE.join(' ')}`)
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
        markAfter('floor', POLL_MS + 1_500),
        { data: 'Spare a word.\r', afterPrevTicks: 2 },
        { data: '', atTick: 999, awaitText: 'Spare.', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'turn' },
        { data: '/usage\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: '', atTick: 999, awaitText: 'asked us to wait', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'tab' },
        { data: 'r', atTick: 999, awaitText: 'asked us to wait', requireAwait: true, minTick: 1, awaitSettleTicks: 2 },
        { data: '', afterPrevTicks: ticks(2_000), mark: 'held' },
        { data: '\x1b', atTick: 999, awaitText: 'asked us to wait', requireAwait: true, minTick: 1, awaitSettleTicks: 2 },
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
  console.log('\nF · the rail at 160 cols — the count, and a 429 with Retry-After is a WAIT on screen')
  console.log(`  [FIXTURE] usage requests: ${asks.map(r => `#${r.n}@${r.s.toFixed(1)}s:${r.status}`).join(' ') || 'none'}`)
  console.log(`  [DEBUG] ${readLines.length} read line(s):`)
  for (const line of readLines) console.log(`    ${line.replace(/^\S+ \[DEBUG\] /, '')}`)
  check('every send became due', c.sends > 0 && c.receipts === c.sends, c.tail.slice(-200))
  const first = asks[0]
  check("the request's identity headers are the release's shape (User-Agent mercury/<version> · Authorization Bearer · anthropic-beta oauth-2025-04-20 · Content-Type application/json)", first !== undefined && /^mercury\/\d+\.\d+\.\d+/.test(first.headers['user-agent'] ?? '') && first.headers.authScheme === 'Bearer' && first.headers['anthropic-beta'] === 'oauth-2025-04-20' && first.headers['content-type'] === 'application/json', JSON.stringify(first?.headers))
  check('every read leaves one debug line naming its reason (open · operator · sign-in) and the host', readLines.length === asks.length && readLines.every(l => /\((open|operator|sign-in)\) GET 127\.0\.0\.1:\d+\/api\/oauth\/usage/.test(l)), `${readLines.length} line(s) for ${asks.length} request(s)`)
  check('the mount read is admitted (200) and the figure paints (5h ≥ 36%)', asks[0]?.status === 200 && (fiveHourPct(c.marks.boot ?? '') ?? 0) >= 36, `#1:${asks[0]?.status} · ${usageBlock(c.marks.boot ?? '')}`)
  const tabAsk = asks[1]
  const beforeTab = asks.filter(r => r.s < (tabAsk?.s ?? Number.POSITIVE_INFINITY)).length
  check(`a floor passing and a completed turn read nothing — the tab's own ask is the SECOND request (${beforeTab} before it)`, beforeTab === 1 && (fiveHourPct(c.marks.turn ?? '') ?? 0) >= 36, asks.map(r => `#${r.n}@${r.s.toFixed(1)}s`).join(' '))
  const refused = asks.find(r => r.status === 429)
  check(`the tab's ask trips the limiter: 429 with Retry-After ${RETRY_AFTER_S} s`, refused !== undefined && readLines.some(l => /HTTP 429 · retry-after 240 s/.test(l)), asks.map(r => `#${r.n}:${r.status}`).join(' '))
  const tab = c.marks.tab ?? ''
  check("the tab says 'the usage endpoint asked us to wait … (HTTP 429, host)' — the wording, the 429 and the host — never 'Failed to load'", /the usage endpoint asked us to wait/.test(tab) && /HTTP 429/.test(tab) && /127\.0\.0\.1/.test(tab) && !/Failed to load/.test(tab), tab.split('\n').filter(l => /wait|429/.test(l)).join(' | '))
  const afterRefused = refused !== undefined ? asks.filter(r => r.s > refused.s) : []
  check(`the operator's retry inside the server's wait is HELD — no read re-trips the endpoint (${afterRefused.length} read(s) after the 429)`, refused !== undefined && afterRefused.length === 0, asks.map(r => `#${r.n}:${r.status}`).join(' '))
  const held = c.marks['after-usage'] ?? ''
  check("the rail's compact note says 'wait 4m · HTTP 429' and the figure still stands (5h ≥ 36%, never blanked)", /wait 4m · HTTP 429/.test(held.replace(/\s+/g, ' ')) && !/read failed/.test(held) && (fiveHourPct(held) ?? 0) >= 36, usageBlock(held))
  const record = join(home, 'usage-reader.json')
  let recorded: { families?: Record<string, { status?: number; retryAfterMs?: number; recoveredAtMs?: number }> } = {}
  try {
    recorded = JSON.parse(readFileSync(record, 'utf8')) as typeof recorded
  } catch {
  }
  const fam = recorded.families?.anthropic
  check("the doctor's record names the 429 and the stated wait (Retry-After 240 s)", fam?.status === 429 && fam.retryAfterMs === RETRY_AFTER_S * 1000, existsSync(record) ? readFileSync(record, 'utf8').slice(0, 300) : 'no record')
}

console.log(failures === 0 ? '\n✅ prove-usage-freshness-captures — all checks pass' : `\n❌ prove-usage-freshness-captures — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
