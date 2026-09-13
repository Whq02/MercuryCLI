#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureArgv0, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import {
  AGENT_DESCRIPTION,
  AGENT_TURN_ASK,
  carriersOf,
  childEnv,
  CLOCK_TOLERANCE_MS,
  DIST,
  exportWorld,
  inMainFile,
  isDrainedMainRow,
  j,
  LINE,
  makeTally,
  MODEL,
  NODE,
  QUEUED_PLATE,
  removeWorld,
  REPO,
  SCRATCH_ROOT,
  seedHome,
  startFixture,
  WIN,
  briefly,
} from './dupline-world.ts'

const { check, section, finish, failed } = makeTally('prove-dupline-agent-drain-drive')

section('C the whole product in a terminal: the row paints once, with the clock it was sent at, before and after the turn ends')
const driver = resolveCaptureDriver()
const preflight = driver.kind === 'unavailable' ? null : preflightCaptureDriver(driver, REPO)
if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else if (driver.kind === 'unavailable' || preflight === null || !preflight.ok) {
  console.log(`  [skip] no capture engine on this box — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : describeCapturePreflight(preflight!)}`)
} else {
  const PTY_HOME = join(SCRATCH_ROOT, `mercury-dupline-pty-${process.pid}`)
  const PTY_CWD = join(PTY_HOME, 'fixture-repo')
  seedHome(PTY_HOME, PTY_CWD)
  const pfx = await startFixture(join(PTY_HOME, 'wire.jsonl'), 25)
  const out = join(PTY_HOME, 'grid.json')
  const CTRL_O = '\x0f'
  const sends = [
    { requireAwait: true, minTick: 3, awaitText: 'choose', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'hello there\r' },
    { requireAwait: true, minTick: 5, awaitText: 'heard: hello there', awaitSettleTicks: 3, data: `${AGENT_TURN_ASK}\r`, mark: 'answered' },
    { requireAwait: true, minTick: 5, awaitText: AGENT_DESCRIPTION, awaitSettleTicks: 10, data: `${LINE}\r`, mark: 'sent' },
    { requireAwait: true, minTick: 5, awaitText: QUEUED_PLATE, awaitSettleTicks: 1, data: '', mark: 'queued' },
    { requireAwait: true, minTick: 2, awaitText: `done: ${AGENT_TURN_ASK}`, awaitSettleTicks: 5, data: '', mark: 'end' },
    { afterPrevTicks: 50, data: CTRL_O, mark: 'end+10s' },
    { afterPrevTicks: 10, data: CTRL_O, mark: 'end+12s-view' },
    { afterPrevTicks: 10, data: '', mark: 'end+14s' },
    { afterPrevTicks: 80, data: '', mark: 'end+30s' },
  ]
  const hostProfile = WIN && !process.env.WT_SESSION ? { hostProfile: 'wt' } : {}
  const cfg = { argv: [resolveCaptureArgv0(NODE, driver), DIST, '--model', MODEL], cwd: PTY_CWD, sends, total: 1200, readyText: `done: ${AGENT_TURN_ASK}`, readySettleTicks: 3, cols: 120, rows: 40, out, ...hostProfile }
  const cfgPath = join(PTY_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = { ...childEnv(PTY_HOME, pfx.port), VSHOT_SLOTS: process.env.VSHOT_SLOTS ?? '3', ...('hostProfile' in hostProfile ? { TERM: 'xterm-256color', COLORTERM: 'truecolor' } : {}) }
  const stderr: string[] = []
  const status = await new Promise<number | null>(resolve => {
    const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: PTY_CWD, env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', () => resolve(null))
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  pfx.kill()
  check('the capture ran the whole journey', status === 0 && existsSync(out), `status=${status} ${stderr.join('').slice(-300)}`)
  type Grid = Array<Array<{ c?: string }>>
  const gridText = (grid: Grid): string => grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n')
  const marks: Record<string, string> = {}
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
    for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
    check("the capture ended on the turn's own final text", payload.endReason === 'ready', String(payload.endReason))
  }
  const operatorRows = (frame: string | undefined): string[] =>
    (frame ?? '')
      .split('\n')
      .filter(l => {
        const at = l.indexOf('[sam]')
        return at >= 0 && l.indexOf(LINE, at) > at
      })
      .map(l => l.replace(/\s+/g, ' ').trim())
  const clockOf = (row: string): string => (/(\d\d:\d\d:\d\d)\s+\[sam\]/.exec(row)?.[1] ?? row.split('[sam]')[0]!.replace(/[│\s]/g, ''))
  let sentAtMs: number | null = null
  try {
    const trace = readFileSync(join(PTY_HOME, 'connector-trace.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { t: number; ev: string; state?: string })
    const queuedSend = trace.filter(r => r.ev === 'send' && r.state === 'queued').pop()
    if (queuedSend !== undefined) sentAtMs = queuedSend.t
  } catch {
  }
  check('the connector recorded the send as queued under the running turn', sentAtMs !== null)
  const secondsOfDay = (hhmmss: string): number => {
    const m = /^(\d\d):(\d\d):(\d\d)$/.exec(hhmmss)
    return m === null ? Number.NaN : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  const sendClock = sentAtMs === null ? '' : new Date(sentAtMs).toTimeString().slice(0, 8)
  const clockNear = (row: string): boolean => {
    const a = secondsOfDay(clockOf(row))
    const b = secondsOfDay(sendClock)
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= CLOCK_TOLERANCE_MS / 1000
  }
  const queuedRows = operatorRows(marks.queued)
  check('while the sub-agent runs, the line paints once, as a queued row', queuedRows.length === 1 && /(^|[^A-Za-z])queued\s+\[sam\]/.test(queuedRows[0]!), j(queuedRows))
  for (const label of ['end', 'end+10s', 'end+14s', 'end+30s']) {
    const rows = operatorRows(marks[label])
    check(`at ${label}: exactly one row carries the line, stamped with the clock it was sent at (${sendClock})`, rows.length === 1 && clockNear(rows[0]!), j(rows))
  }
  const viewRows = operatorRows(marks['end+12s-view'])
  check('the detailed transcript view shows the line once, with the send clock', viewRows.length === 1 && clockNear(viewRows[0]!), j(viewRows))
  const ptyCarriers = carriersOf(join(PTY_HOME, 'projects'), LINE)
  const ptyMain = ptyCarriers.filter(isDrainedMainRow)
  check("the session's transcript holds the drained row once, stamped at the send, and no sub-agent's transcript holds it", ptyMain.length === 1 && ptyCarriers.every(inMainFile) && sentAtMs !== null && Math.abs(Date.parse(ptyMain[0]!.occurredAt) - sentAtMs) <= CLOCK_TOLERANCE_MS, briefly(ptyCarriers))
  exportWorld('terminal', PTY_HOME, { ...Object.fromEntries(Object.entries(marks).map(([label, text]) => [`${label}.txt`, `${text}\n`])), 'capture-stderr.txt': stderr.join('') })
  if (failed() === 0) await removeWorld(PTY_HOME)
  else {
    console.log(`  [forensics] terminal world kept: ${PTY_HOME}`)
    for (const label of ['queued', 'end', 'end+30s']) {
      console.log(`\n── ${label} ──`)
      for (const row of (marks[label] ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 150)}`)
    }
  }
}

finish()
