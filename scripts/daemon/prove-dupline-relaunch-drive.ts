#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureArgv0, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { AGENT_DESCRIPTION, LINE, RELAUNCH_TURN_ASK } from './dupline-fixture-words.ts'
import {
  briefly,
  carriersOf,
  childEnv,
  CLOCK_TOLERANCE_MS,
  DIST,
  exportWorld,
  inMainFile,
  j,
  makeTally,
  MODEL,
  NODE,
  QUEUED_PLATE,
  removeWorld,
  REPO,
  requestsOf,
  SCRATCH_ROOT,
  seedHome,
  sleep,
  startFixture,
  waitWire,
  WIN,
} from './dupline-world.ts'

const { check, section, finish, failed } = makeTally('prove-dupline-relaunch-drive')
const RESTART_HINT = 'the runner restarted'

section("R the whole product in a terminal: the runner is relaunched while a line is queued behind a sub-agent's run")
const driver = resolveCaptureDriver()
const preflight = driver.kind === 'unavailable' ? null : preflightCaptureDriver(driver, REPO)
if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else if (driver.kind === 'unavailable' || preflight === null || !preflight.ok) {
  console.log(`  [skip] no capture engine on this box — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : describeCapturePreflight(preflight!)}`)
} else {
  const PTY_HOME = join(SCRATCH_ROOT, `mercury-dupline-relaunch-pty-${process.pid}`)
  const PTY_CWD = join(PTY_HOME, 'fixture-repo')
  seedHome(PTY_HOME, PTY_CWD)
  const pfx = await startFixture(join(PTY_HOME, 'wire.jsonl'), 5, 6)
  const out = join(PTY_HOME, 'grid.json')
  const sends = [
    { requireAwait: true, minTick: 3, awaitText: 'choose', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'hello there\r' },
    { requireAwait: true, minTick: 5, awaitText: 'heard: hello there', awaitSettleTicks: 3, data: `${RELAUNCH_TURN_ASK}\r`, mark: 'answered' },
    { requireAwait: true, minTick: 5, awaitText: AGENT_DESCRIPTION, awaitSettleTicks: 8, data: `${LINE}\r`, mark: 'sent' },
    { requireAwait: true, minTick: 5, awaitText: QUEUED_PLATE, awaitSettleTicks: 1, data: '', mark: 'queued' },
    { requireAwait: true, minTick: 5, awaitText: RESTART_HINT, awaitSettleTicks: 5, data: '', mark: 'relaunched' },
    { afterPrevTicks: 50, data: '', mark: 'relaunched+10s' },
    { afterPrevTicks: 10, data: `${LINE}\r`, mark: 'resent' },
    { requireAwait: true, minTick: 2, awaitText: `heard: ${LINE}`, awaitSettleTicks: 5, data: '', mark: 'end' },
    { afterPrevTicks: 50, data: '', mark: 'end+10s' },
  ]
  const hostProfile = WIN && !process.env.WT_SESSION ? { hostProfile: 'wt' } : {}
  const cfg = { argv: [resolveCaptureArgv0(NODE, driver), DIST, '--model', MODEL], cwd: PTY_CWD, sends, total: 1500, readyText: `heard: ${LINE}`, readySettleTicks: 3, cols: 120, rows: 40, out, ...hostProfile }
  const cfgPath = join(PTY_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = { ...childEnv(PTY_HOME, pfx.port), VSHOT_SLOTS: process.env.VSHOT_SLOTS ?? '3', ...('hostProfile' in hostProfile ? { TERM: 'xterm-256color', COLORTERM: 'truecolor' } : {}) }
  const stderr: string[] = []
  const capture = new Promise<number | null>(resolve => {
    const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: PTY_CWD, env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(360_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', () => resolve(null))
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  type Worker = { runnerId?: string; sessionId?: string; pid?: number; endedAt?: number }
  const liveWorker = (): Worker | undefined => {
    try {
      const all = JSON.parse(readFileSync(join(PTY_HOME, 'daemon', 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Worker> }
      return Object.values(all.workers).find(w => w.endedAt === undefined && typeof w.pid === 'number')
    } catch {
      return undefined
    }
  }
  const crossed = await waitWire(pfx.wire, "the sub-agent's request after its first boundary", w => w.kind === 'request' && w.arm === 'subrelaunch' && w.step === 1, vshotBudgetMs(150_000))
  const worker = liveWorker()
  let killedAtMs: number | null = null
  let killedPid: number | undefined
  if (crossed !== null && worker?.pid !== undefined) {
    await sleep(1500)
    try {
      process.kill(worker.pid, 'SIGKILL')
      killedAtMs = Date.now()
      killedPid = worker.pid
    } catch (err) {
      console.log(`  [kill] the runner could not be ended: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  check("the runner was ended after the sub-agent's first boundary, while the line was queued behind it", crossed !== null && killedAtMs !== null, j({ crossed: crossed !== null, worker }))
  const status = await capture
  pfx.kill()
  check('the capture ran the whole journey', status === 0 && existsSync(out), `status=${status} ${stderr.join('').slice(-300)}`)
  type Grid = Array<Array<{ c?: string }>>
  const gridText = (grid: Grid): string => grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n')
  const marks: Record<string, string> = {}
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
    for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
    check("the capture ended on the re-sent line's answer", payload.endReason === 'ready', String(payload.endReason))
  }
  const operatorRows = (frame: string | undefined): string[] =>
    (frame ?? '')
      .split('\n')
      .filter(l => {
        const at = l.indexOf('[sam]')
        return at >= 0 && l.indexOf(LINE, at) > at
      })
      .map(l => l.replace(/\s+/g, ' ').trim())
  const hintRows = (frame: string | undefined): string[] => (frame ?? '').split('\n').filter(l => l.includes(RESTART_HINT)).map(l => l.replace(/\s+/g, ' ').trim())
  const clockOf = (row: string): string => /(\d\d:\d\d:\d\d)\s+\[sam\]/.exec(row)?.[1] ?? row.split('[sam]')[0]!.replace(/[│\s]/g, '')
  const secondsOfDay = (hhmmss: string): number => {
    const m = /^(\d\d):(\d\d):(\d\d)$/.exec(hhmmss)
    return m === null ? Number.NaN : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  const clockText = (ms: number): string => new Date(ms).toTimeString().slice(0, 8)
  const near = (row: string, ms: number | null): boolean => {
    if (ms === null) return false
    const a = secondsOfDay(clockOf(row))
    const b = secondsOfDay(clockText(ms))
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= CLOCK_TOLERANCE_MS / 1000
  }
  let resentMs: number | null = null
  let lostCount: number | null = null
  try {
    const trace = readFileSync(join(PTY_HOME, 'connector-trace.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { t: number; ev: string; state?: string; reason?: string; count?: number })
    const lost = trace.find(r => r.ev === 'lost' && r.reason === 'runner-relaunched')
    if (lost !== undefined) lostCount = lost.count ?? null
    const sendsAfterKill = trace.filter(r => r.ev === 'send' && killedAtMs !== null && r.t > killedAtMs)
    if (sendsAfterKill.length > 0) resentMs = sendsAfterKill[0]!.t
  } catch {
  }
  const queuedRows = operatorRows(marks.queued)
  check('while the sub-agent runs, the line paints once, as a queued row', queuedRows.length === 1 && /(^|[^A-Za-z])queued\s+\[sam\]/.test(queuedRows[0]!), j(queuedRows))
  check('the connector retired exactly one send as lost with the relaunched runner', lostCount === 1, j(lostCount))
  check('past the relaunch, ten seconds after its hint, no row carries the line (a row standing here would be the stray)', marks['relaunched+10s'] !== undefined && operatorRows(marks['relaunched+10s']).length === 0, j(operatorRows(marks['relaunched+10s'])))
  check('at relaunched: the hint names the line as not taken and no row carries the line', hintRows(marks.relaunched).length >= 1 && operatorRows(marks.relaunched).length === 0, j({ hint: hintRows(marks.relaunched), rows: operatorRows(marks.relaunched) }))
  check('at relaunched+10s: no row carries the line (the hint has had its eight seconds)', marks['relaunched+10s'] !== undefined && operatorRows(marks['relaunched+10s']).length === 0, j(operatorRows(marks['relaunched+10s'])))
  for (const label of ['end', 'end+10s']) {
    const rows = operatorRows(marks[label])
    check(`at ${label}: exactly one row carries the line — the re-sent one, stamped with its own send clock (${resentMs === null ? '-' : clockText(resentMs)})`, rows.length === 1 && near(rows[0]!, resentMs), j(rows))
  }
  const requests = requestsOf(pfx.wire)
  check("no request of the sub-agent carried the line, before or after the relaunch", requests.filter(r => r.arm === 'subrelaunch').every(r => (r.counts?.[LINE] ?? 0) === 0), j(requests.map(r => [r.n, r.arm, r.step, r.counts?.[LINE]])))
  const carriers = carriersOf(join(PTY_HOME, 'projects'), LINE)
  check("no sub-agent's transcript holds the line; the session's transcript holds only the re-sent row", carriers.every(inMainFile) && carriers.filter(inMainFile).length === 1 && resentMs !== null && Date.parse(carriers[0]!.occurredAt) >= resentMs - CLOCK_TOLERANCE_MS, briefly(carriers))
  exportWorld('terminal-relaunch', PTY_HOME, { ...Object.fromEntries(Object.entries(marks).map(([label, text]) => [`${label}.txt`, `${text}\n`])), 'capture-stderr.txt': stderr.join(''), 'kill.json': j({ killedAtMs, killedPid, worker }) })
  if (failed() === 0) await removeWorld(PTY_HOME)
  else {
    console.log(`  [forensics] terminal world kept: ${PTY_HOME}`)
    for (const label of ['queued', 'relaunched', 'relaunched+10s', 'end']) {
      console.log(`\n── ${label} ──`)
      for (const row of (marks[label] ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 150)}`)
    }
    for (const file of ['daemon/daemon.log', 'connector-trace.jsonl']) {
      const path = join(PTY_HOME, file)
      if (!existsSync(path)) continue
      console.log(`\n── ${file} (the last forty lines) ──`)
      for (const row of readFileSync(path, 'utf8').trim().split('\n').slice(-40)) console.log(`│ ${row.slice(0, 220)}`)
    }
  }
}

finish()
