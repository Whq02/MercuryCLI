#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bootRunner, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { answerOf, frameLines, isOutcome, isSession, type Frame } from '../lib/rows.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-compact-rows-own-output')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const SUMMARY_REQUEST = 'Produce the analysis and summary now'
const FAILURE = 'Error during compaction'
const CONTEXT_HEAD = '## Context Usage'
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'compact-own-output-')))

let summary: 'refused' | 'written' = 'written'
const fixture = await startScriptedFixture(req =>
  req.ask.includes(SUMMARY_REQUEST)
    ? [{ type: 'text', text: summary === 'refused' ? '' : '<analysis>walk</analysis>\n<summary>\n1. Operator Intent: plain turns for a rows probe.\n</summary>' }]
    : [{ type: 'text', text: `answered ${req.n}` }],
)
const port = Number(new URL(fixture.base).port)

type World = { runHome: string; cwd: string; env: NodeJS.ProcessEnv }
type Step = { ask: string; summary?: 'refused' | 'written' }
type Run = { frames: Frame[]; stderr: string; exitCode: number | null }

function world(name: string): World {
  const runHome = join(root, name, 'home')
  const cwd = join(root, name, 'work')
  seedScratchHome(runHome, cwd)
  return { runHome, cwd, env: { ...childEnv(runHome, port), MERCURY_COMPACT_KEEP_TAIL: '1' } }
}

async function live(w: World, steps: Step[]): Promise<{ sessionId: string; turns: Frame[][] }> {
  const runner = bootRunner({ cwd: w.cwd, env: w.env })
  const turns: Frame[][] = []
  for (const step of steps) {
    if (step.summary !== undefined) summary = step.summary
    const from = runner.frames.length
    await runner.host.request('queue/add', { type: 'prompt', content: step.ask, id: randomUUID() }, bound(90_000))
    await runner.waitFor(step.ask, isOutcome, bound(90_000), from)
    turns.push(runner.frames.slice(from))
  }
  const sessionId = String(runner.frames.find(isSession)?.session_id ?? '')
  await runner.stop(bound(5_000))
  return { sessionId, turns }
}

function runRows(w: World, argv: string[], ask: string): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', ...argv, ask], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ frames: frameLines(stdout), stderr, exitCode })
    }
    const timer = setTimeout(() => {
      console.log(`  [wait] run ${argv.join(' ')}: no exit within the budget`)
      child.kill('SIGKILL')
    }, bound(120_000))
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', code => finish(code))
    child.on('error', () => finish(null))
  })
}

function transcriptOf(w: World, sessionId: string): string | null {
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        const found = walk(full)
        if (found !== null) return found
      } else if (name === `${sessionId}.jsonl`) return full
    }
    return null
  }
  return sessionId !== '' && existsSync(w.runHome) ? walk(w.runHome) : null
}
const linesOf = (file: string | null): string[] => (file === null ? [] : readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== ''))
const noticesOf = (file: string | null, needle: string): number => linesOf(file).filter(l => l.includes('"noticeKind":"local_command"') && l.includes(needle)).length
const localCommandRecordsOf = (file: string | null): number => linesOf(file).filter(l => l.includes('local-command-std') || l.includes('"noticeKind":"local_command"')).length

const commandRows = (frames: Frame[]): Frame[] => frames.filter(f => f.type === 'command_output')
const foldsEnded = (frames: Frame[]): number => frames.filter(f => f.type === 'compaction' && f.state === 'ended').length
const textsOf = (rows: Frame[]): string[] => rows.map(r => String(r.text ?? '').slice(0, 80))
const textOf = (row: Frame | undefined): string => String(row?.text ?? '')
const outcomeOf = (frames: Frame[]): Frame | undefined => frames.find(isOutcome)
const foldedOk = (run: Run): boolean => {
  const outcome = outcomeOf(run.frames)
  const answer = answerOf(outcome)
  return run.exitCode === 0 && outcome?.status === 'completed' && answer.includes('Compacted') && answer.includes('kept verbatim')
}
const plain: Step[] = Array.from({ length: 9 }, (_, i) => ({ ask: `plain turn number ${i + 1}` }))

tally.section('§1 the field shape — a session whose transcript holds a failed /compact, then a /compact through the rows door that succeeds')
const field = world('field')
const failed = await live(field, [...plain, { ask: '/compact', summary: 'refused' }])
const failedRows = commandRows(failed.turns.at(-1) ?? [])
tally.check('the failing /compact announces its own failure once: the error row of that run stays', failedRows.length === 1 && textOf(failedRows[0]).includes(FAILURE), JSON.stringify(textsOf(failedRows)))
const fieldTranscript = transcriptOf(field, failed.sessionId)
tally.check('the session transcript holds the failure as a local-command notice', noticesOf(fieldTranscript, FAILURE) === 1, JSON.stringify({ fieldTranscript, notices: noticesOf(fieldTranscript, FAILURE) }))
summary = 'written'
const resumed = await runRows(field, ['--resume', failed.sessionId, '--fork', '--model', MODEL], '/compact')
const resumedRows = commandRows(resumed.frames)
tally.check('the resumed /compact exits 0 and completes with the Compacted line, the last messages kept verbatim', foldedOk(resumed), JSON.stringify({ exit: resumed.exitCode, answer: answerOf(outcomeOf(resumed.frames)).slice(0, 120), stderr: resumed.stderr.slice(0, 160) }))
tally.check('the run announces exactly one command_output row (red on the base: two, the earlier failure first)', resumedRows.length === 1, JSON.stringify(textsOf(resumedRows)))
tally.check('that row is the Compacted line of this run', resumedRows.length >= 1 && textOf(resumedRows.at(-1)).startsWith('Compacted'), JSON.stringify(textsOf(resumedRows)))
tally.check('no row of the run repeats the earlier failure', resumedRows.every(r => !textOf(r).includes(FAILURE)), JSON.stringify(textsOf(resumedRows)))
tally.check('the fold boundary is still announced once', foldsEnded(resumed.frames) === 1, String(foldsEnded(resumed.frames)))

tally.section('§2 the live seat — /context, a failed /compact, then /compact in the same session with no resume')
const seat = world('seat')
const lived = await live(seat, [...plain, { ask: '/context' }, { ask: '/compact', summary: 'refused' }, { ask: '/compact', summary: 'written' }])
const [contextTurn = [], failedTurn = [], foldTurn = []] = lived.turns.slice(-3)
const contextRows = commandRows(contextTurn)
tally.check('/context announces its own output once, as it did before', contextRows.length === 1 && textOf(contextRows[0]).startsWith(CONTEXT_HEAD), JSON.stringify(textsOf(contextRows)))
tally.check('the failing /compact announces its own failure once', commandRows(failedTurn).length === 1 && textOf(commandRows(failedTurn)[0]).includes(FAILURE), JSON.stringify(textsOf(commandRows(failedTurn))))
const foldRows = commandRows(foldTurn)
tally.check('the next /compact completes with the Compacted line, the last messages kept verbatim', answerOf(outcomeOf(foldTurn)).includes('Compacted') && answerOf(outcomeOf(foldTurn)).includes('kept verbatim'), answerOf(outcomeOf(foldTurn)).slice(0, 120))
tally.check('it announces exactly one command_output row (red on the base: three, the /context output and the failure first)', foldRows.length === 1 && textOf(foldRows[0]).startsWith('Compacted'), JSON.stringify(textsOf(foldRows)))
tally.check('no row of it repeats the /context output or the failure', foldRows.every(r => !textOf(r).startsWith(CONTEXT_HEAD) && !textOf(r).includes(FAILURE)), JSON.stringify(textsOf(foldRows)))

tally.section('§3 the control — a session with no earlier local-command record: /compact yields its one row as it always did')
const calm = world('calm')
const calmed = await live(calm, plain)
const calmTranscript = transcriptOf(calm, calmed.sessionId)
tally.check('the session transcript holds no local-command record', calmTranscript !== null && localCommandRecordsOf(calmTranscript) === 0, JSON.stringify({ calmTranscript, records: localCommandRecordsOf(calmTranscript) }))
summary = 'written'
const control = await runRows(calm, ['--resume', calmed.sessionId, '--fork', '--model', MODEL], '/compact')
const controlRows = commandRows(control.frames)
tally.check('the /compact exits 0 and completes with the Compacted line, the last messages kept verbatim', foldedOk(control), JSON.stringify({ exit: control.exitCode, answer: answerOf(outcomeOf(control.frames)).slice(0, 120), stderr: control.stderr.slice(0, 160) }))
tally.check('the run announces exactly one command_output row, the Compacted line', controlRows.length === 1 && textOf(controlRows[0]).startsWith('Compacted'), JSON.stringify(textsOf(controlRows)))
tally.check('the fold boundary is announced once', foldsEnded(control.frames) === 1, String(foldsEnded(control.frames)))

await fixture.close()
rmSync(root, { recursive: true, force: true })
tally.finish()
