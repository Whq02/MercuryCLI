#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handoffTurn } from '../lib/fixtureApi.ts'
import { dist, runDoor, sceneRoot, type Row } from './lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
let count = 0
const check = (label: string, good: boolean, detail = ''): void => {
  count++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
if (!existsSync(dist)) {
  console.log(`FAIL — ${dist} is missing; build first`)
  process.exit(1)
}

type Hook = { name: string; match: string; run: string; timeout: number }
type Scene = { label: string; tool: 'Read' | 'Bash'; command?: string; before?: Hook[]; after?: Hook[]; cutAfterMs?: number }
type Played = { code: number | null; rows: Row[]; waits: Row[]; ends: Row[]; said: string[]; seconds: number[]; resultAt: number; stderr: string }

async function play(scene: Scene): Promise<Played> {
  const paths = sceneRoot(`hook-wait-${scene.label}-`)
  const target = join(paths.cwd, 'README.md')
  writeFileSync(target, 'readme words\n')
  const result = await runDoor(paths, {
    turns: [
      scene.tool === 'Read'
        ? { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'wait_call_1' }
        : { kind: 'tool_use', name: 'Bash', input: { command: scene.command ?? 'true', description: 'the held command' }, id: 'wait_call_1' },
      { kind: 'text', text: 'fixture answered' },
      handoffTurn(),
    ],
    hooks: { ...(scene.before ? { 'tool.before': scene.before } : {}), ...(scene.after ? { 'tool.after': scene.after } : {}) },
    args: ['--mode', 'sovereign'],
    ...(scene.cutAfterMs !== undefined ? { signalAfterRequest: { request: 1, delayMs: scene.cutAfterMs, signal: 'SIGTERM' as const } } : {}),
  })
  const updates = result.rows.filter(row => row.type === 'tool_update' && row.source === 'hook')
  const waits = updates.filter(row => typeof row.line === 'string' && row.line !== '')
  const ends = updates.filter(row => !waits.includes(row))
  const said = result.rows.filter(row => JSON.stringify(row).includes('waiting on ')).map(row => String(row.line ?? row.text ?? JSON.stringify(row)))
  const resultAt = result.rows.findIndex(row => row.type === 'tool_result' && row.call_id === 'wait_call_1')
  rmSync(paths.root, { recursive: true, force: true })
  return { code: result.code, rows: result.rows, waits, ends, said, seconds: waits.map(row => Number(row.elapsed_s)), resultAt, stderr: result.stderr }
}
const completed = (played: Played): boolean => played.code === 0 && played.rows.some(row => row.type === 'outcome' && row.status === 'completed') && played.rows.some(row => row.type === 'tool_result' && row.status === 'ok')
const countsUp = (seconds: number[]): boolean => seconds.every((value, index) => Number.isInteger(value) && (index === 0 || value > seconds[index - 1]!))
const j = (value: unknown): string => JSON.stringify(value)
const at = (played: Played, row: Row | undefined): number => (row === undefined ? -1 : played.rows.indexOf(row))
const when = (row: Row | undefined): number => Date.parse(String(row?.timestamp ?? ''))
const hookRows = (played: Played): string => j(played.rows.filter(row => (row.type === 'tool_update' && row.source === 'hook') || row.type === 'tool_result' || row.type === 'outcome').map(row => (row.type === 'tool_update' ? (row.line ?? 'no line') : row.type)))
const withdrawnOnce = (played: Played): boolean =>
  played.waits.length >= 1 && played.ends.length === 1 && played.ends[0]!.elapsed_s === undefined && at(played, played.ends[0]) > at(played, played.waits.at(-1)) && played.resultAt > at(played, played.ends[0])

console.log(`build under proof: ${dist}`)

console.log('\n§1 a hook that answers at once never puts the wait line on the stream, so there is nothing to take back')
{
  const one = await play({ label: 'fast-one', tool: 'Read', before: [{ name: 'guard', match: 'Read', run: 'true', timeout: 10 }] })
  check('one fast tool.before hook: the call runs and the turn completes', completed(one), `code ${one.code} ${one.stderr.slice(0, 300)}`)
  check('…and no row says "waiting on hook guard": not at 0 s, not at all', one.waits.length === 0 && one.said.length === 0, j(one.said))
  check('…and no hook row of any kind goes out for it', one.ends.length === 0, hookRows(one))
  const many = await play({
    label: 'fast-many',
    tool: 'Read',
    before: [
      { name: 'guard', match: 'Read', run: 'true', timeout: 10 },
      { name: 'second-guard', match: 'Read', run: 'true', timeout: 10 },
    ],
    after: [{ name: 'after-guard', match: 'Read', run: 'true', timeout: 10 }],
  })
  check('two fast tool.before hooks and a fast tool.after hook: the turn completes', completed(many), `code ${many.code} ${many.stderr.slice(0, 300)}`)
  check('…and no row says "waiting on" for either event, and none takes anything back', many.waits.length === 0 && many.said.length === 0 && many.ends.length === 0, hookRows(many))
}

console.log('\n§2 a hook that holds the call is said from its first whole second, the count goes up, and one row takes the line back when the hook ends')
{
  const slow = await play({ label: 'slow-before', tool: 'Read', before: [{ name: 'slow-guard', match: 'Read', run: 'sleep 3.5', timeout: 10 }] })
  console.log(`  the hook rows of a tool.before hook that holds 3.5 s: ${hookRows(slow)}`)
  check('a slow tool.before hook: the turn completes', completed(slow), `code ${slow.code} ${slow.stderr.slice(0, 300)}`)
  check('the first wait row comes after a whole second, never at 0 s', slow.seconds.length >= 1 && slow.seconds[0]! >= 1 && slow.seconds[0]! <= 2 && !slow.seconds.includes(0), j(slow.seconds))
  check('the seconds count up, one row a second, and stop inside the hold', slow.seconds.length >= 2 && slow.seconds.length <= 5 && countsUp(slow.seconds), j(slow.seconds))
  check('each row names the hook and its timeout: "waiting on hook slow-guard · N s of 10"', slow.waits.length > 0 && slow.waits.every(row => row.line === `waiting on hook slow-guard · ${String(row.elapsed_s)} s of 10`), j(slow.waits.map(row => row.line)))
  check('every wait row stands before the result of the call it held', slow.resultAt > 0 && slow.waits.every(row => slow.rows.indexOf(row) < slow.resultAt), `${slow.waits.map(row => slow.rows.indexOf(row)).join(',')} against ${slow.resultAt}`)
  check('when the hook ends, one row with no line takes the wait back, after the last count and before the result', withdrawnOnce(slow), hookRows(slow))
}
{
  const after = await play({ label: 'slow-after', tool: 'Read', after: [{ name: 'slow-after', match: 'Read', run: 'sleep 3.5', timeout: 10 }] })
  console.log(`  the hook rows of a tool.after hook that holds 3.5 s: ${hookRows(after)}`)
  check('a slow tool.after hook: the turn completes', completed(after), `code ${after.code} ${after.stderr.slice(0, 300)}`)
  check('its first wait row comes after a whole second and the count goes up', after.seconds.length >= 2 && after.seconds[0]! >= 1 && after.seconds[0]! <= 2 && !after.seconds.includes(0) && countsUp(after.seconds), j(after.seconds))
  check('each row names it: "waiting on hook slow-after · N s of 10"', after.waits.length > 0 && after.waits.every(row => row.line === `waiting on hook slow-after · ${String(row.elapsed_s)} s of 10`), j(after.waits.map(row => row.line)))
  check('when it ends, one row with no line takes the wait back before the result', withdrawnOnce(after), hookRows(after))
}
{
  const many = await play({
    label: 'slow-many',
    tool: 'Read',
    before: [
      { name: 'first', match: 'Read', run: 'sleep 3.5', timeout: 10 },
      { name: 'second', match: 'Read', run: 'sleep 1.3', timeout: 20 },
    ],
  })
  console.log(`  the hook rows of two tool.before hooks at once: ${hookRows(many)}`)
  check('two slow tool.before hooks at once: the turn completes', completed(many), `code ${many.code} ${many.stderr.slice(0, 300)}`)
  check('they are said together from the first whole second: "waiting on 2 tool.before hooks (first, second) · N s of 20"', many.waits.length >= 2 && many.seconds[0]! >= 1 && many.seconds[0]! <= 2 && !many.seconds.includes(0) && countsUp(many.seconds) && many.waits.every(row => row.line === `waiting on 2 tool.before hooks (first, second) · ${String(row.elapsed_s)} s of 20`), j(many.waits.map(row => row.line)))
  check('one row takes the wait of the two back, once, when the last of them ends', withdrawnOnce(many), hookRows(many))
}

const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const { onSeatRow, onSeatSettled } = await import('../../src/daemon/sessionSeat.ts')
const { readSessionProgress } = await import('../../src/services/engine-connector/seatProjections.ts')
const { hookWaitLineOf, hookWaitSeconds, hookWaitWords } = await import('../../src/utils/hooks/wait.ts')

console.log('\n§2b the count never stands still and never goes back, whatever the timer and the wall clock do')
{
  const since = 1_700_000_000_000
  const counted = (atMs: number[]): number[] => {
    let seconds = 0
    return atMs.map(at => (seconds = hookWaitSeconds(seconds + 1, since, since + at)))
  }
  const early = counted([999, 1999, 2999])
  const byTheClockAlone = [999, 1999, 2999].map(at => Math.floor(at / 1000))
  console.log(`  three ticks, each a millisecond short of its second: the rows count ${j(early)}; the wall clock alone would count ${j(byTheClockAlone)}`)
  check('three ticks that each fire a millisecond early count 1, 2, 3, where the whole seconds of the wall clock alone read 0, 1, 2', j(early) === '[1,2,3]' && j(byTheClockAlone) === '[0,1,2]', `${j(early)} | ${j(byTheClockAlone)}`)
  const lateThenEarly = [counted([2001, 2999]), counted([5001, 5999])]
  check('a tick that fires late and the next a millisecond early count on: 2 then 3, 5 then 6, never the same second twice', j(lateThenEarly) === '[[2,3],[5,6]]', j(lateThenEarly))
  const steppedBack = counted([5001, 3000, 3900])
  check('a wall clock set back during the wait does not take the count back: 5, 6, 7', j(steppedBack) === '[5,6,7]', j(steppedBack))
  check('a tick that fires late counts every whole second that has passed, never fewer', j(counted([1000, 5400])) === '[1,5]', j(counted([1000, 5400])))
  const wait = { event: 'tool.after' as const, names: ['slow-after'], sinceMs: since, timeoutS: 10 }
  const lines = early.map(seconds => hookWaitWords(wait, since + seconds * 1000))
  check('the row says the count it carries: "waiting on hook slow-after · 3 s of 10" at the third such tick', lines[2] === 'waiting on hook slow-after · 3 s of 10' && lines[0] === 'waiting on hook slow-after · 1 s of 10', j(lines))
}

type Step = { after: Row; line: string | null; entries: number }
async function throughAWindow(rows: Row[]): Promise<Step[]> {
  const scratch = sceneRoot('hook-wait-window-')
  const dir = join(scratch.root, 'daemon')
  mkdirSync(dir, { recursive: true })
  const short = `w${randomUUID().slice(0, 6)}`
  const sessionId = randomUUID()
  updateConcourseWorkers(workers => {
    workers[short] = { schema: 1, runnerId: short, sessionId, workspaceId: scratch.root, isolation: 'shared', modelKey: 'claude-sonnet-5', spawnedAt: Date.now(), lastLiveAt: Date.now(), pid: process.pid } as never
  }, dir)
  const roster = { door: () => undefined, list: () => [], patchSeatModel: () => false, patchSeatEffort: () => false } as never
  const steps: Step[] = []
  try {
    for (const row of rows) {
      if (row.type !== 'tool_update' && row.type !== 'tool_result' && row.type !== 'outcome') continue
      onSeatRow(short, row as never, roster, dir)
      await Bun.sleep(150)
      const tools = readSessionProgress(sessionId, dir)?.tools ?? {}
      const frames = Object.values(tools).map(entry => ({ data: { type: entry.dataType, event: 'tool.before', name: '', state: 'waiting', count: 1, ...(entry.latestLine !== undefined ? { line: entry.latestLine } : {}) } }))
      steps.push({ after: row, line: hookWaitLineOf(frames as never), entries: Object.keys(tools).length })
    }
  } finally {
    onSeatSettled(short)
    rmSync(scratch.root, { recursive: true, force: true })
  }
  return steps
}
const read = (steps: Step[]): string => j(steps.map(step => [step.after.type !== 'tool_update' ? step.after.type : step.after.source !== 'hook' ? `${String(step.after.source)} update` : (step.after.line ?? 'no line'), step.line]))
const stepOf = (steps: Step[], row: Row | undefined): Step | undefined => steps.find(step => step.after === row)

console.log('\n§3 the line is gone when the hook ends: a command that runs on after its hook is not counted against it')
const held = await play({ label: 'gone', tool: 'Bash', command: 'sleep 3', before: [{ name: 'brief-guard', match: 'Bash', run: 'sleep 2.5', timeout: 10 }] })
{
  console.log(`  the hook rows of a 2.5 s hook before a 3 s command: ${hookRows(held)}`)
  check('a 2.5 s hook before a 3 s command: the turn completes', completed(held), `code ${held.code} ${held.stderr.slice(0, 300)}`)
  check('the hook is said while it holds and no longer: its counts stop at its own length, none while the command runs', held.seconds.length >= 1 && held.seconds.length <= 3 && held.seconds[0]! >= 1 && Math.max(...held.seconds) <= 3 && !held.seconds.includes(0) && countsUp(held.seconds), j(held.seconds))
  check('one row takes the wait back when the hook ends', withdrawnOnce(held), hookRows(held))
  const sinceLastCount = when(held.ends[0]) - when(held.waits.at(-1))
  const untilResult = when(held.rows[held.resultAt]) - when(held.ends[0])
  console.log(`  the row that takes it back: ${sinceLastCount} ms after the last count, ${untilResult} ms before the command's result`)
  check('…and it goes out when the hook ends, before the command has run: within a second and a half of the last count, and two seconds or more before the result', held.ends.length === 1 && sinceLastCount >= 0 && sinceLastCount < 1500 && untilResult >= 2000, `${sinceLastCount} ms after the last count, ${untilResult} ms before the result`)
}

console.log('\n§4 what a window reads: the rows of that run through the session\'s own progress record and the working strip\'s own selector')
{
  const steps = await throughAWindow(held.rows)
  console.log(`  each row the record took, and the line the strip would show after it: ${read(steps)}`)
  const shown = stepOf(steps, held.waits[0])
  const taken = stepOf(steps, held.ends[0])
  const result = stepOf(steps, held.rows[held.resultAt])
  const outcome = steps.find(step => step.after.type === 'outcome')
  check('while the hook holds the call, a window that reads the record shows the wait, in the words of the row', shown !== undefined && typeof shown.line === 'string' && shown.line === held.waits[0]!.line && shown.line.startsWith('waiting on hook brief-guard · '), read(steps))
  check('once the hook has ended the record holds no line for the call, and the strip shows none while the command runs', taken !== undefined && taken.line === null, read(steps))
  check('…and none stands when the call\'s result arrives', result !== undefined && result.line === null, read(steps))
  check('the turn\'s outcome empties the record', outcome !== undefined && outcome.entries === 0 && outcome.line === null, read(steps))
}

console.log('\n§5 a second hook of the same call shows its own line, and each is taken back when its hook ends')
{
  const both = await play({
    label: 'before-and-after',
    tool: 'Bash',
    command: 'sleep 0.2',
    before: [{ name: 'first-guard', match: 'Bash', run: 'sleep 2.5', timeout: 10 }],
    after: [{ name: 'after-guard', match: 'Bash', run: 'sleep 2.5', timeout: 10 }],
  })
  console.log(`  the hook rows of a slow tool.before hook and a slow tool.after hook on one call: ${hookRows(both)}`)
  check('a slow hook before a call and a slow hook after it: the turn completes', completed(both), `code ${both.code} ${both.stderr.slice(0, 300)}`)
  const named = (line: unknown): string | null => (typeof line !== 'string' ? null : line.startsWith('waiting on hook first-guard · ') ? 'first-guard' : line.startsWith('waiting on hook after-guard · ') ? 'after-guard' : line)
  const squeezed = <T>(values: T[]): T[] => values.filter((value, index) => index === 0 || value !== values[index - 1])
  const onTheStream = squeezed(both.rows.slice(0, both.resultAt).filter(row => row.type === 'tool_update' && row.source === 'hook').map(row => named(row.line)))
  check('the rows say the first hook, take it back, say the second, take it back, and then the result comes', j(onTheStream) === j(['first-guard', null, 'after-guard', null]), j(onTheStream))
  const steps = await throughAWindow(both.rows)
  const resultStep = steps.findIndex(step => step.after.type === 'tool_result')
  const inAWindow = squeezed(steps.slice(0, resultStep + 1).map(step => named(step.line)))
  check('a window reads the same: the first hook\'s line, none, the second hook\'s own line, none', j(inAWindow) === j(['first-guard', null, 'after-guard', null]), read(steps))
}

console.log('\n§6 the other ways a hook ends take the line back too: its timeout, its failure, the turn being cut')
{
  const timedOut = await play({ label: 'timed-out', tool: 'Bash', command: 'true', before: [{ name: 'stuck-guard', match: 'Bash', run: 'sleep 30', timeout: 3 }] })
  console.log(`  the hook rows of a hook ended at its 3 s timeout: ${hookRows(timedOut)}`)
  check('a hook ended at its timeout: the wait was said against that timeout, and one row takes it back before the call\'s result', timedOut.waits.length >= 1 && timedOut.waits.every(row => row.line === `waiting on hook stuck-guard · ${String(row.elapsed_s)} s of 3`) && withdrawnOnce(timedOut), hookRows(timedOut))
  const failed = await play({ label: 'failed', tool: 'Bash', command: 'true', before: [{ name: 'failing-guard', match: 'Bash', run: 'sleep 2.5; exit 1', timeout: 10 }] })
  console.log(`  the hook rows of a hook that fails after 2.5 s: ${hookRows(failed)}`)
  check('a hook that fails: one row takes its wait back before the call\'s result', withdrawnOnce(failed), hookRows(failed))
  const cut = await play({ label: 'cut', tool: 'Bash', command: 'true', before: [{ name: 'long-guard', match: 'Bash', run: 'sleep 30', timeout: 60 }], cutAfterMs: 3500 })
  console.log(`  the hook rows of a turn cut while its hook was being waited on: ${hookRows(cut)}`)
  const steps = await throughAWindow(cut.rows)
  check('a turn cut mid-wait: the wait had been said, the run ends interrupted, and no line stands after its last row', cut.waits.length >= 1 && cut.rows.some(row => row.type === 'outcome' && row.status === 'interrupted') && steps.length > 0 && steps.at(-1)!.line === null, `${hookRows(cut)} · ${read(steps)}`)
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('HOOK WAIT AFTER A SECOND RED')
  process.exit(1)
}
console.log('HOOK WAIT AFTER A SECOND GREEN')
