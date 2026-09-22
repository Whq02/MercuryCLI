#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureArgv0, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { describeCapturePreflight, preflightCaptureDriver } from '../lib/capturePreflight.ts'
import { AFTER_RETURN_LINE, AGENT_DESCRIPTION, AGENT_TURN_ASK, CREW_NOTICE, CREW_TURN_ASK, doneText, FIRST_LINE, QUICK_DESCRIPTION, RETURN_LINE, SECOND_LINE } from './dupline-fixture-words.ts'
import {
  briefly,
  carriersOf,
  childEnv,
  CLOCK_TOLERANCE_MS,
  DIST,
  exportWorld,
  inMainFile,
  isDrainedMainRow,
  j,
  makeTally,
  MODEL,
  NODE,
  QUEUED_PLATE,
  queueJournal,
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

const { check, section, finish, failed } = makeTally('prove-dupline-arms-drive')

section("C the whole product in a terminal: two lines and a crew notice during a sub-agent's run, each painted once, at its own clock")
const driver = resolveCaptureDriver()
const preflight = driver.kind === 'unavailable' ? null : preflightCaptureDriver(driver, REPO)
if (!existsSync(DIST)) {
  check('the built bundle is present (the drive boots the BUILT product)', false, DIST)
} else if (driver.kind === 'unavailable' || preflight === null || !preflight.ok) {
  console.log(`  [skip] no capture engine on this box — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : describeCapturePreflight(preflight!)}`)
} else {
  const PTY_HOME = join(SCRATCH_ROOT, `mercury-dupline-arms-pty-${process.pid}`)
  const PTY_CWD = join(PTY_HOME, 'fixture-repo')
  seedHome(PTY_HOME, PTY_CWD)
  const pfx = await startFixture(join(PTY_HOME, 'wire.jsonl'), 25)
  const out = join(PTY_HOME, 'grid.json')
  const CTRL_O = '\x0f'
  const sends = [
    { requireAwait: true, minTick: 3, awaitText: 'choose', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'hello there\r' },
    { requireAwait: true, minTick: 5, awaitText: 'heard: hello there', awaitSettleTicks: 3, data: `${CREW_TURN_ASK}\r`, mark: 'answered' },
    { requireAwait: true, minTick: 5, awaitText: AGENT_DESCRIPTION, awaitSettleTicks: 15, data: `${FIRST_LINE}\r`, mark: 'sent-1' },
    { afterPrevTicks: 20, data: `${SECOND_LINE}\r`, mark: 'sent-2' },
    { requireAwait: true, minTick: 5, awaitText: QUEUED_PLATE, awaitSettleTicks: 1, data: '', mark: 'queued' },
    { requireAwait: true, minTick: 2, awaitText: doneText(CREW_TURN_ASK), awaitSettleTicks: 5, data: '', mark: 'end' },
    { afterPrevTicks: 50, data: CTRL_O, mark: 'end+10s' },
    { afterPrevTicks: 10, data: CTRL_O, mark: 'end+12s-view' },
    { afterPrevTicks: 10, data: '', mark: 'end+14s' },
    { afterPrevTicks: 80, data: '', mark: 'end+30s' },
  ]
  const hostProfile = WIN && !process.env.WT_SESSION ? { hostProfile: 'wt' } : {}
  const cfg = { argv: [resolveCaptureArgv0(NODE, driver), DIST, '--model', MODEL], cwd: PTY_CWD, sends, total: 1200, readyText: doneText(CREW_TURN_ASK), readySettleTicks: 3, cols: 120, rows: 40, out, ...hostProfile }
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
  const rowsWith = (frame: string | undefined, word: string, plate = '[sam]'): string[] =>
    (frame ?? '')
      .split('\n')
      .filter(l => {
        const at = l.indexOf(plate)
        return at >= 0 && l.indexOf(word, at) > at
      })
      .map(l => l.replace(/\s+/g, ' ').trim())
  const clockOf = (row: string, plate: string): string => new RegExp(`(\\d\\d:\\d\\d:\\d\\d)\\s+${plate.replace(/[[\]]/g, '\\$&')}`).exec(row)?.[1] ?? row.split(plate)[0]!.replace(/[│\s]/g, '')
  const secondsOfDay = (hhmmss: string): number => {
    const m = /^(\d\d):(\d\d):(\d\d)$/.exec(hhmmss)
    return m === null ? Number.NaN : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  const clockText = (ms: number): string => new Date(ms).toTimeString().slice(0, 8)
  const near = (row: string, plate: string, ms: number | null): boolean => {
    if (ms === null) return false
    const a = secondsOfDay(clockOf(row, plate))
    const b = secondsOfDay(clockText(ms))
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= CLOCK_TOLERANCE_MS / 1000
  }
  let firstSentMs: number | null = null
  let secondSentMs: number | null = null
  try {
    const trace = readFileSync(join(PTY_HOME, 'connector-trace.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { t: number; ev: string; state?: string })
    const queuedSends = trace.filter(r => r.ev === 'send' && r.state === 'queued')
    if (queuedSends.length >= 2) {
      firstSentMs = queuedSends[queuedSends.length - 2]!.t
      secondSentMs = queuedSends[queuedSends.length - 1]!.t
    }
  } catch {
  }
  check('the connector recorded both sends as queued under the running turn', firstSentMs !== null && secondSentMs !== null)
  const requests = requestsOf(pfx.wire)
  const returned = requests.find(r => r.arm === 'crew' && r.step === 1)
  check("the session's own request after the Agent tool carried both lines and the notice, once each", returned !== undefined && returned.counts?.[FIRST_LINE] === 1 && returned.counts?.[SECOND_LINE] === 1 && returned.counts?.[CREW_NOTICE] === 1, j(returned?.counts))
  check('no request of either agent carried a line or the notice', requests.filter(r => r.arm === 'subwork' || r.arm === 'quick').every(r => (r.counts?.[FIRST_LINE] ?? 0) === 0 && (r.counts?.[SECOND_LINE] ?? 0) === 0 && (r.counts?.[CREW_NOTICE] ?? 0) === 0), j(requests.map(r => [r.n, r.arm, r.step, r.counts?.[FIRST_LINE], r.counts?.[SECOND_LINE], r.counts?.[CREW_NOTICE]])))
  const queuedFirst = rowsWith(marks.queued, FIRST_LINE)
  const queuedSecond = rowsWith(marks.queued, SECOND_LINE)
  check('while the sub-agent sleeps, each line paints once, as a queued row', queuedFirst.length === 1 && queuedSecond.length === 1 && /(^|[^A-Za-z])queued\s+\[sam\]/.test(queuedFirst[0]!) && /(^|[^A-Za-z])queued\s+\[sam\]/.test(queuedSecond[0]!), j([queuedFirst, queuedSecond]))
  for (const label of ['end', 'end+10s', 'end+14s', 'end+30s']) {
    const first = rowsWith(marks[label], FIRST_LINE)
    const second = rowsWith(marks[label], SECOND_LINE)
    check(`at ${label}: the first line paints once, stamped with the clock it was sent at (${firstSentMs === null ? '-' : clockText(firstSentMs)})`, first.length === 1 && near(first[0]!, '[sam]', firstSentMs), j(first))
    check(`at ${label}: the second line paints once, stamped with the clock it was sent at (${secondSentMs === null ? '-' : clockText(secondSentMs)})`, second.length === 1 && near(second[0]!, '[sam]', secondSentMs), j(second))
    const notice = rowsWith(marks[label], `Agent "${QUICK_DESCRIPTION}" completed`, '●')
    check(`at ${label}: the crew notice paints once, stamped at the Agent tool's return (${returned === undefined ? '-' : clockText(returned.at)})`, notice.length === 1 && near(notice[0]!, '●', returned?.at ?? null), j(notice))
  }
  const viewFirst = rowsWith(marks['end+12s-view'], FIRST_LINE)
  const viewSecond = rowsWith(marks['end+12s-view'], SECOND_LINE)
  const viewNotice = rowsWith(marks['end+12s-view'], `Agent "${QUICK_DESCRIPTION}" completed`, '●')
  check('the detailed transcript view shows each line once with its send clock, and the notice once', viewFirst.length === 1 && near(viewFirst[0]!, '[sam]', firstSentMs) && viewSecond.length === 1 && near(viewSecond[0]!, '[sam]', secondSentMs) && viewNotice.length === 1, j([viewFirst, viewSecond, viewNotice]))
  const projects = join(PTY_HOME, 'projects')
  const firstCarriers = carriersOf(projects, FIRST_LINE)
  const secondCarriers = carriersOf(projects, SECOND_LINE)
  const noticeCarriers = carriersOf(projects, CREW_NOTICE)
  check("the session's transcript holds each line once as the drained row stamped at its send, and no sub-agent's transcript holds either", firstCarriers.filter(isDrainedMainRow).length === 1 && firstCarriers.every(inMainFile) && secondCarriers.filter(isDrainedMainRow).length === 1 && secondCarriers.every(inMainFile) && firstSentMs !== null && secondSentMs !== null && Math.abs(Date.parse(firstCarriers.find(isDrainedMainRow)!.occurredAt) - firstSentMs) <= CLOCK_TOLERANCE_MS && Math.abs(Date.parse(secondCarriers.find(isDrainedMainRow)!.occurredAt) - secondSentMs) <= CLOCK_TOLERANCE_MS, briefly([...firstCarriers, ...secondCarriers]))
  check("the session's transcript holds the notice once, delivered at the Agent tool's return, and no sub-agent's transcript holds it", noticeCarriers.filter(isDrainedMainRow).length === 1 && noticeCarriers.every(inMainFile) && returned !== undefined && Math.abs(Date.parse(noticeCarriers.find(isDrainedMainRow)!.occurredAt) - returned.at) <= CLOCK_TOLERANCE_MS, briefly(noticeCarriers))
  exportWorld('terminal-arms', PTY_HOME, { ...Object.fromEntries(Object.entries(marks).map(([label, text]) => [`${label}.txt`, `${text}\n`])), 'capture-stderr.txt': stderr.join('') })
  if (failed() === 0) await removeWorld(PTY_HOME)
  else {
    console.log(`  [forensics] terminal world kept: ${PTY_HOME}`)
    for (const label of ['queued', 'end', 'end+30s']) {
      console.log(`\n── ${label} ──`)
      for (const row of (marks[label] ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 150)}`)
    }
  }
}

if (existsSync(DIST) && driver.kind !== 'unavailable' && preflight !== null && preflight.ok) {
  section("D the whole product in a terminal: two lines typed after the Agent tool's return, while the session's final answer is held, paint as two rows and land as two rows")
  const failedAtOpen = failed()
  const D_HOME = join(SCRATCH_ROOT, `mercury-dupline-arms-return-${process.pid}`)
  const D_CWD = join(D_HOME, 'fixture-repo')
  seedHome(D_HOME, D_CWD)
  const release = join(D_HOME, 'release-final-answer')
  const dfx = await startFixture(join(D_HOME, 'wire.jsonl'), 6, 6, 0, release)
  const out = join(D_HOME, 'grid.json')
  const sends = [
    { requireAwait: true, minTick: 3, awaitText: 'choose', awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'hello there\r' },
    { requireAwait: true, minTick: 5, awaitText: 'heard: hello there', awaitSettleTicks: 3, data: `${AGENT_TURN_ASK}\r`, mark: 'asked' },
    { afterPrevTicks: 150, data: `${RETURN_LINE}\r`, mark: 'sent-1' },
    { afterPrevTicks: 8, data: `${AFTER_RETURN_LINE}\r`, mark: 'sent-2' },
    { afterPrevTicks: 10, data: '', mark: 'queued' },
    { requireAwait: true, minTick: 2, awaitText: `heard: ${AFTER_RETURN_LINE}`, awaitSettleTicks: 5, data: '', mark: 'end' },
    { afterPrevTicks: 50, data: '', mark: 'end+10s' },
  ]
  const hostProfile = WIN && !process.env.WT_SESSION ? { hostProfile: 'wt' } : {}
  const cfg = { argv: [resolveCaptureArgv0(NODE, driver), DIST, '--model', MODEL], cwd: D_CWD, sends, total: 1500, readyText: `heard: ${AFTER_RETURN_LINE}`, readySettleTicks: 3, cols: 120, rows: 40, out, ...hostProfile }
  const cfgPath = join(D_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = { ...childEnv(D_HOME, dfx.port), VSHOT_SLOTS: process.env.VSHOT_SLOTS ?? '3', ...('hostProfile' in hostProfile ? { TERM: 'xterm-256color', COLORTERM: 'truecolor' } : {}) }
  const stderr: string[] = []
  const capture = new Promise<number | null>(resolve => {
    const child = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: D_CWD, env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(360_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', () => resolve(null))
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  const held = await waitWire(dfx.wire, "the fixture holding the session's final answer", x => x.kind === 'held', vshotBudgetMs(150_000))
  const projects = join(D_HOME, 'projects')
  const bothQueued = async (): Promise<boolean> => {
    const until = Date.now() + vshotBudgetMs(90_000)
    for (;;) {
      const journal = queueJournal(projects)
      if ([RETURN_LINE, AFTER_RETURN_LINE].every(word => journal.some(row => row.operation === 'enqueue' && row.content === word))) return true
      if (Date.now() >= until) return false
      await sleep(200)
    }
  }
  const queued = held !== null && (await bothQueued())
  await sleep(4_000)
  const releasedBefore = dfx.wire().some(x => x.kind === 'released')
  writeFileSync(release, '')
  const status = await capture
  dfx.kill()
  check("the final answer was held when both lines were queued (the hold on the wire before either enqueue, no release until the proof's)", held !== null && queued && !releasedBefore, j({ held: held?.at, released: dfx.wire().find(x => x.kind === 'released')?.at, journal: queueJournal(projects).slice(-4) }))
  check('the capture ran the whole journey', status === 0 && existsSync(out), `status=${status} ${stderr.join('').slice(-300)}`)
  type Grid = Array<Array<{ c?: string }>>
  const gridText = (grid: Grid): string => grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n')
  const marks: Record<string, string> = {}
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
    for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
    check("the capture ended on the batch turn's own answer", payload.endReason === 'ready', String(payload.endReason))
  }
  const plated = (frame: string | undefined, word: string): string[] =>
    (frame ?? '')
      .split('\n')
      .filter(l => {
        const at = l.indexOf('[sam]')
        return at >= 0 && l.indexOf(word, at) > at
      })
      .map(l => l.replace(/\s+/g, ' ').trim())
  const requests = requestsOf(dfx.wire)
  const batchTurn = requests.find(r => (r.counts?.[RETURN_LINE] ?? 0) > 0 && r.arm !== 'subwork')
  check('the session read both lines once each, in one request, in the order sent', batchTurn !== undefined && batchTurn.counts?.[RETURN_LINE] === 1 && batchTurn.counts?.[AFTER_RETURN_LINE] === 1 && (batchTurn.firstAt?.[RETURN_LINE] ?? 0) < (batchTurn.firstAt?.[AFTER_RETURN_LINE] ?? -1), j(requests.map(r => [r.n, r.arm, r.step, r.counts?.[RETURN_LINE], r.counts?.[AFTER_RETURN_LINE]])))
  check('while the answer was held, each typed line painted once as a queued row', plated(marks.queued, RETURN_LINE).length === 1 && plated(marks.queued, AFTER_RETURN_LINE).length === 1, j([plated(marks.queued, RETURN_LINE), plated(marks.queued, AFTER_RETURN_LINE)]))
  for (const label of ['end', 'end+10s']) {
    check(`at ${label}: each line paints as a row of its own, under its own plate`, plated(marks[label], RETURN_LINE).length === 1 && plated(marks[label], AFTER_RETURN_LINE).length === 1, j([plated(marks[label], RETURN_LINE), plated(marks[label], AFTER_RETURN_LINE)]))
  }
  const returnRows = carriersOf(projects, RETURN_LINE).filter(inMainFile)
  const afterRows = carriersOf(projects, AFTER_RETURN_LINE).filter(inMainFile)
  check("the session's transcript holds each line as a row of its own, the first before the second, no row carrying both", returnRows.length === 1 && afterRows.length === 1 && returnRows[0]!.recordId !== afterRows[0]!.recordId && Number(returnRows[0]!.ordinal) < Number(afterRows[0]!.ordinal), briefly([...returnRows, ...afterRows]))
  exportWorld('terminal-return', D_HOME, { ...Object.fromEntries(Object.entries(marks).map(([label, text]) => [`${label}.txt`, `${text}\n`])), 'capture-stderr.txt': stderr.join('') })
  if (failed() === failedAtOpen) await removeWorld(D_HOME)
  else {
    console.log(`  [forensics] terminal return world kept: ${D_HOME}`)
    for (const label of ['queued', 'end']) {
      console.log(`\n── ${label} ──`)
      for (const row of (marks[label] ?? '(no frame)').split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, 150)}`)
    }
  }
}

finish()
