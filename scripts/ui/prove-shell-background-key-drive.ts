#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { keyHintLabel } from '../../src/components/mercury-ui/keyHintLabel.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }
type Leg = Awaited<ReturnType<typeof startLeg>>
type Hold = { pid: number | null; heldAtMs: number | null; heldAtTick: number | null; release: () => void }

function liveRunnerPids(home: string): number[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'daemon', 'concourse-workers.json'), 'utf8')) as { workers?: Record<string, { pid?: number; endedAt?: number }> }
    return Object.values(raw.workers ?? {}).filter(rec => rec.endedAt === undefined && typeof rec.pid === 'number').map(rec => rec.pid as number)
  } catch {
    return []
  }
}

function runnerRunningShell(pids: readonly number[]): number | null {
  const table = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout ?? ''
  const parent = new Map<number, number>()
  const shells: number[] = []
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m === null) continue
    parent.set(Number(m[1]), Number(m[2]))
    if (m[3]!.startsWith('sleep 40')) shells.push(Number(m[1]))
  }
  for (const shell of shells) {
    for (let cur = shell, hops = 0; hops < 8 && cur > 1; hops++) {
      const up = parent.get(cur)
      if (up === undefined) break
      if (pids.includes(up)) return up
      cur = up
    }
  }
  return null
}

async function holdRunnerOnceItsShellRuns(leg: Leg, giveUpMs = 90_000): Promise<Hold> {
  const started = Date.now()
  let pid: number | null = null
  while (pid === null && Date.now() - started < giveUpMs) {
    pid = runnerRunningShell(liveRunnerPids(leg.home))
    if (pid === null) await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (pid === null) return { pid: null, heldAtMs: null, heldAtTick: null, release: () => {} }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try { process.kill(pid as number, 'SIGCONT') } catch {}
  }
  try { process.kill(pid, 'SIGSTOP') } catch { return { pid, heldAtMs: null, heldAtTick: null, release } }
  const heldAtMs = Date.now()
  setTimeout(release, 30_000).unref?.()
  return { pid, heldAtMs, heldAtTick: null, release }
}

const driver = requireCaptureDriver('shell-background-key')
const COLS = 178
const ROWS = 51
const SOVEREIGN_ARGV = ['--dangerously-bypass-permissions']
const SETTINGS = { skipSovereignConsentPrompt: true, prefersReducedMotion: true, spinnerTipsEnabled: false }
const HINT_ROW = keyHintLabel('esc interrupt · ⇧b background the command')
const TAIL_RUNNING = keyHintLabel('esc interrupts · ⇧b backgrounds · ⇧← back')
const TAIL_PLAIN = keyHintLabel('esc interrupts · ⇧← back')
const SHIFT_B = keyHintLabel('⇧b')
const LANDED = '← back'
const COMMAND = 'sleep 40; echo shell-drive-done'
const ASK = 'run the long command'
const LAST_WORDS = 'watch the rows.'
const FINISHED = 'Finished after the background move'
const MOVED = 'moved this command to the background as task'
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
const tailRow = (rows: string[]): string => rows.find(r => r.includes(keyHintLabel('⇧← back'))) ?? ''
const composerRow = (rows: string[]): string => rows.find(r => /^│❯ /.test(r)) ?? ''

async function capture(tag: string, keyOn: boolean, sends: unknown[], aside?: (leg: Leg) => Promise<Hold>): Promise<{ marks: Map<string, Mark>; status: number | null; log: string; leg: Leg; hold: Hold | null }> {
  const leg = await startLeg(tag, [
    { kind: 'paced_tool_use', preDeltas: ['Running ', 'the long ', 'command ', 'now, ', LAST_WORDS], gapMs: 1500, tools: [{ name: 'Bash', input: { command: COMMAND, description: 'a long command' } }] },
    { kind: 'text', text: `${FINISHED}.` },
  ], null)
  writeFileSync(join(leg.home, 'settings.json'), JSON.stringify(keyOn ? SETTINGS : { ...SETTINGS, backgroundKey: false }))
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const log = join(scratch, `${tag}-engine.log`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [productNode(), DIST, ...SOVEREIGN_ARGV], cwd: ROOT, cols: COLS, rows: ROWS, sends, resizes: [], total: 360, out }))
  const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_DECK_COMPANION: '0', MERCURY_CRITTER: 'clam' }), stdio: ['ignore', 'pipe', 'pipe'] })
  const startedAtMs = Date.now()
  const holding = aside === undefined ? null : aside(leg)
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(360 * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(log, output)
  const hold = holding === null ? null : await holding
  hold?.release()
  if (hold !== null) hold.heldAtTick = hold.heldAtMs === null ? null : Math.round((hold.heldAtMs - startedAtMs) / 200)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    for (const mark of payload.marks ?? []) marks.set(mark.label, mark)
  }
  return { marks, status, log, leg, hold }
}

const opening = [
  { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
  { atTick: 999, awaitText: LANDED, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, requireAwait: true, data: ASK },
  { afterPrevTicks: 2, data: '\r' },
  { atTick: 999, awaitText: 'esc interrupt', minTick: 2, awaitSettleTicks: 1, requireAwait: true, data: '', mark: 'plain' },
]

console.log(`shell background key artifacts: ${scratch} (dist: ${DIST})`)

{
  const run = await capture('shell-background-on', true, [
    ...opening,
    { atTick: 999, awaitText: 'background the command', minTick: 2, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'running' },
    { afterPrevTicks: 2, data: 'B' },
    { atTick: 999, awaitText: FINISHED, minTick: 2, awaitSettleTicks: 3, requireAwait: true, data: '', mark: 'done' },
  ])
  try {
    check('on: the boot, the plain call, the running shell and the continued turn all painted (engine exit 0)', run.status === 0 && ['plain', 'running', 'done'].every(l => run.marks.has(l)), `exit=${run.status}; ${run.log}`)
    const plain = run.marks.get('plain')
    const running = run.marks.get('running')
    const done = run.marks.get('done')
    if (plain !== undefined) {
      const rows = textRows(plain.grid)
      printFrame('on · a plain model call in flight', rows)
      check('on · plain call: the ready line ends with esc interrupts · ⇧← back and no row names ⇧b', tailRow(rows).endsWith(TAIL_PLAIN) && !rows.some(r => r.includes(SHIFT_B)), JSON.stringify(tailRow(rows)))
      check('on · plain call: the hint row reads esc interrupt alone', rows.some(r => r === 'esc interrupt'), JSON.stringify(rows.filter(r => r.startsWith('esc interrupt'))))
    }
    if (running !== undefined) {
      const rows = textRows(running.grid)
      printFrame('on · a shell command running', rows)
      check('on · shell running: the ready line ends with esc interrupts · ⇧b backgrounds · ⇧← back', tailRow(rows).endsWith(TAIL_RUNNING), JSON.stringify(tailRow(rows)))
      const at = rows.indexOf(HINT_ROW)
      check('on · shell running: the hint row reads esc interrupt · ⇧b background the command, directly under the composer and above the newline row', at > 0 && (rows[at - 1] ?? '').startsWith('╰') && (rows[at + 1] ?? '').includes('for a new line'), JSON.stringify(rows.slice(Math.max(0, at - 1), at + 2)))
      check('on · shell running: ⇧b is named on exactly those two rows', rows.filter(r => r.includes(SHIFT_B)).length === 2, String(rows.filter(r => r.includes(SHIFT_B)).length))
    }
    if (done !== undefined) {
      const rows = textRows(done.grid)
      printFrame('on · after ⇧b', rows)
      check('on · after ⇧b: the turn went on to the next reply and no row names ⇧b any more', joined(rows).includes(FINISHED) && !rows.some(r => r.includes(SHIFT_B)))
      const told = run.leg.fixture.requests.some(req => JSON.stringify(req.body).includes(MOVED))
      check('on · after ⇧b: the agent was told the command moved to the background as a task whose output arrives as a notification', told, run.leg.fixture.requests.map(req => JSON.stringify(req.body).slice(-300)).join(' | '))
    }
    check('on: the drive stayed on loopback', nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    await endLeg(run.leg)
  }
}

{
  const run = await capture('shell-background-off', false, [
    ...opening,
    { atTick: 999, awaitText: LAST_WORDS, minTick: 2, awaitSettleTicks: 1, requireAwait: true, data: '' },
    { afterPrevTicks: 15, data: '', mark: 'running' },
    { afterPrevTicks: 2, data: 'B' },
    { afterPrevTicks: 3, data: '', mark: 'typed' },
  ])
  try {
    check('off: the boot, the plain call and the running shell painted (engine exit 0)', run.status === 0 && ['plain', 'running', 'typed'].every(l => run.marks.has(l)), `exit=${run.status}; ${run.log}`)
    const running = run.marks.get('running')
    const typed = run.marks.get('typed')
    if (running !== undefined) {
      const rows = textRows(running.grid)
      printFrame('off · a shell command running, the setting off', rows)
      check('off · shell running: the command is on the canvas', joined(rows).includes('a long command') || joined(rows).includes('sleep 40'))
      check('off · shell running: both rows read as shipped — esc interrupts · ⇧← back and esc interrupt, no ⇧b', tailRow(rows).endsWith(TAIL_PLAIN) && rows.some(r => r === 'esc interrupt') && !rows.some(r => r.includes(SHIFT_B)), JSON.stringify(tailRow(rows)))
    }
    if (typed !== undefined) {
      const rows = textRows(typed.grid)
      check('off · B typed: the letter lands in the composer and the command runs on', composerRow(rows).includes('❯ B') && !joined(rows).includes(FINISHED), JSON.stringify(composerRow(rows)))
    }
    check('off: the drive stayed on loopback', nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    await endLeg(run.leg)
  }
}

{
  const REFUSAL = "the session's runner did not answer the background-shell within 10s"
  const run = await capture('shell-background-refused', true, [
    ...opening,
    { atTick: 999, awaitText: 'background the command', minTick: 2, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'running' },
    { afterPrevTicks: 45, data: 'B' },
    { afterPrevTicks: 5, data: '', mark: 'pressed' },
    { afterPrevTicks: 60, data: '', mark: 'refused' },
    { afterPrevTicks: 15, data: '', mark: 'later' },
  ], holdRunnerOnceItsShellRuns)
  try {
    check('refused: the boot, the plain call, the running shell, the press and the answer all painted (engine exit 0)', run.status === 0 && ['running', 'pressed', 'refused', 'later'].every(l => run.marks.has(l)), `exit=${run.status}; ${run.log}`)
    const pressed = run.marks.get('pressed')
    const refused = run.marks.get('refused')
    const later = run.marks.get('later')
    check('refused: the runner was held while its shell command ran, before ⇧b was pressed', run.hold !== null && run.hold.pid !== null && run.hold.heldAtTick !== null && pressed !== undefined && run.hold.heldAtTick < pressed.atTick - 5, JSON.stringify({ pid: run.hold?.pid, heldAtTick: run.hold?.heldAtTick, pressedAtTick: pressed?.atTick }))
    if (pressed !== undefined) {
      const rows = textRows(pressed.grid)
      printFrame('refused · a second after ⇧b, the seat still waiting on the held runner', rows)
      check('refused · after the press: the command still runs and no answer has come yet', rows.indexOf(HINT_ROW) > 0 && !rows.some(r => r.includes(REFUSAL)) && !joined(rows).includes(FINISHED), JSON.stringify(rows.filter(r => r.includes('runner'))))
    }
    if (refused !== undefined) {
      const rows = textRows(refused.grid)
      printFrame('refused · the seat\'s answer on the notice row', rows)
      const at = rows.findIndex(r => r.includes(REFUSAL))
      check('refused: the seat\'s own sentence reaches the operator on the row under the composer', at > 0 && (rows[at - 1] ?? '').startsWith('╰') && (rows[at + 1] ?? '').includes('for a new line'), JSON.stringify(rows.slice(Math.max(0, at - 1), at + 2)))
      check('refused: the command was not moved — the turn is still open and the ready line still names ⇧b', !joined(rows).includes(FINISHED) && tailRow(rows).endsWith(TAIL_RUNNING), JSON.stringify(tailRow(rows)))
    }
    if (later !== undefined) {
      const rows = textRows(later.grid)
      check('refused · three seconds on: the sentence still stands (the channel\'s own clock, no clock of the chord\'s)', rows.some(r => r.includes(REFUSAL)), JSON.stringify(rows.filter(r => r.includes('runner'))))
    }
    check('refused: the drive stayed on loopback', nonLoopback(netlines(run.leg.netlog)).length === 0)
  } finally {
    run.hold?.release()
    await endLeg(run.leg)
  }
}

finish('shell-background-key')
