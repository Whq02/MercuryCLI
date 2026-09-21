#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, joined, netlines, nonLoopback, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'
import { keyHintLabel } from '../../src/components/mercury-ui/keyHintLabel.ts'

type Cell = { c: string }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Grid }
type Leg = Awaited<ReturnType<typeof startLeg>>

const driver = requireCaptureDriver('shell-background-key')
const COLS = 178
const ROWS = 51
const SOVEREIGN_ARGV = ['--dangerously-bypass-permissions']
const SETTINGS = { skipSovereignConsentPrompt: true, prefersReducedMotion: true, spinnerTipsEnabled: false }
const HINT_ROW = keyHintLabel('esc interrupt · ⇧b background the command')
const TAIL_RUNNING = keyHintLabel('esc interrupts · ⇧b backgrounds · ⇧← back')
const TAIL_PLAIN = keyHintLabel('esc interrupts · ⇧← back')
const SHIFT_B = keyHintLabel('⇧b')
const COMMAND = 'sleep 40; echo shell-drive-done'
const ASK = 'run the long command'
const LAST_WORDS = 'watch the rows.'
const FINISHED = 'Finished after the background move'
const MOVED = 'moved this command to the background as task'
const textRows = (grid: Grid): string[] => grid.map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))
const tailRow = (rows: string[]): string => rows.find(r => r.includes(keyHintLabel('⇧← back'))) ?? ''
const composerRow = (rows: string[]): string => rows.find(r => /^│❯ /.test(r)) ?? ''

async function capture(tag: string, keyOn: boolean, sends: unknown[]): Promise<{ marks: Map<string, Mark>; status: number | null; log: string; leg: Leg }> {
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
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const status = await new Promise<number | null>(resolve => {
    const wall = setTimeout(() => { output += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(360 * 200 + 60_000))
    child.once('error', error => { output += `\n${String(error)}\n` })
    child.once('close', code => { clearTimeout(wall); resolve(code) })
  })
  writeFileSync(log, output)
  const marks = new Map<string, Mark>()
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }
    for (const mark of payload.marks ?? []) marks.set(mark.label, mark)
  }
  return { marks, status, log, leg }
}

const opening = [
  { atTick: 40, awaitText: FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r', mark: 'boot' },
  { atTick: 999, awaitText: ADMITTED, minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, requireAwait: true, data: ASK },
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

finish('shell-background-key')
