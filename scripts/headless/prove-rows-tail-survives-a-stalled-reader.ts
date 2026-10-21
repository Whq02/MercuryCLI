#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const tally = makeTally('prove-rows-tail-survives-a-stalled-reader')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ASK = 'rows channel probe: run the quiet step, then answer at length'
const ANSWER_HEAD = 'the answer after the quiet step:'
const ANSWER = `${ANSWER_HEAD}\n${Array.from({ length: 6_000 }, (_, i) => createHash('sha256').update(`row ${i}`).digest('hex')).join('\n')}`
const STALL_MS = 5_000

type Frame = Record<string, unknown>
type Run = { frames: Frame[]; bytes: number; exit: number | null; signal: string | null; stderr: string; aliveAfterStall: boolean; exitedAtMs: number | null; resumedAtMs: number; t0: number; readerLog: string }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rows-stalled-reader-')))
let homes = 0

const READER = join(scratch, 'stalled-reader.cjs')
writeFileSync(
  READER,
  [
    "const { spawn } = require('node:child_process')",
    'const [mode, stallMs, budgetMs, cwd, ...argv] = process.argv.slice(2)',
    "const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })",
    'const t0 = Date.now()',
    "const frames = []; let bytes = 0; let pending = ''; let stderr = ''; let exit = null; let signal = null; let exitedAtMs = null; let stalled = false; let resumedAtMs = 0; let aliveAfterStall = false",
    'child.on(\'exit\', (code, sig) => { exit = code; signal = sig; exitedAtMs = Date.now() })',
    "child.stderr.on('data', c => { stderr += c.toString('utf8') })",
    'const consume = chunk => {',
    "  bytes += chunk.length; pending += chunk.toString('utf8'); let at = pending.indexOf('\\n')",
    '  while (at !== -1) {',
    "    const line = pending.slice(0, at); pending = pending.slice(at + 1)",
    "    if (line.trim() !== '') { try { frames.push(JSON.parse(line)) } catch { frames.push({ type: 'unparseable', line: line.slice(0, 80) }) } }",
    "    at = pending.indexOf('\\n')",
    '  }',
    '}',
    "child.stdout.on('data', chunk => {",
    '  consume(chunk)',
    "  if (mode === 'slow') { child.stdout.pause(); setTimeout(() => child.stdout.resume(), 150); return }",
    "  if (!stalled && frames.some(f => f.type === 'tool_call' || f.type === 'wait')) {",
    '    stalled = true',
    '    child.stdout.pause()',
    '    setTimeout(() => {',
    '      aliveAfterStall = exit === null && child.exitCode === null',
    '      resumedAtMs = Date.now()',
    "      if (mode === 'close') child.stdout.destroy()",
    '      else child.stdout.resume()',
    '    }, Number(stallMs))',
    '  }',
    '})',
    'const finish = () => {',
    "  process.stdout.write(JSON.stringify({ frames: frames.map(f => ({ type: f.type, state: f.state, status: f.status, line: f.line, head: typeof f.text === 'string' ? f.text.slice(0, 40) : undefined, answer: typeof f.answer === 'string' ? f.answer.slice(0, 40) : undefined })), bytes, exit, signal, stderr, aliveAfterStall, exitedAtMs, resumedAtMs, t0 }) + '\\n')",
    '  process.exit(0)',
    '}',
    "const deadline = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; child.stdout.resume() }, Number(budgetMs))",
    "child.on('close', () => { clearTimeout(deadline); finish() })",
  ].join('\n') + '\n',
)

async function runWithReader(mode: 'stall-then-read' | 'close' | 'slow'): Promise<Run> {
  const runHome = join(scratch, `home-${++homes}`)
  const cwd = join(runHome, 'work')
  const fixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1', description: 'the quiet step' } }]
    return [{ type: 'text', text: ANSWER }]
  })
  seedScratchHome(runHome, cwd)
  const port = Number(new URL(fixture.base).port)
  const reader: ChildProcess = spawn(NODE, [READER, mode, String(STALL_MS), String(vshotBudgetMs(60_000)), cwd, NODE, DIST, 'run', '--format', 'rows', '--mode', 'sovereign', '--model', MODEL, '--', ASK], {
    cwd,
    env: childEnv(runHome, port) as Record<string, string | undefined>,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let readerLog = ''
  reader.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  reader.stderr!.on('data', (chunk: Buffer) => {
    readerLog += chunk.toString('utf8')
  })
  await new Promise<void>(resolve => reader.on('close', () => resolve()))
  await fixture.close()
  const line = out.split('\n').find(l => l.trim().startsWith('{'))
  if (line === undefined) return { frames: [], bytes: 0, exit: null, signal: null, stderr: '', aliveAfterStall: false, exitedAtMs: null, resumedAtMs: 0, t0: 0, readerLog }
  return { ...(JSON.parse(line) as Omit<Run, 'readerLog'>), readerLog }
}

const seconds = (ms: number | null, t0: number): string => (ms === null || ms === 0 ? 'never' : `${((ms - t0) / 1000).toFixed(2)}s`)
const kinds = (run: Run): string => run.frames.map(f => `${String(f.type)}${f.state !== undefined ? `:${String(f.state)}` : ''}`).join(' ')

tally.section('a reader that stops reading for a while, then reads again: every row reaches it, the outcome last')
{
  const run = await runWithReader('stall-then-read')
  const outcome = run.frames.find(f => f.type === 'outcome')
  const answerRows = run.frames.filter(f => f.type === 'text' && String(f.head ?? '').startsWith(ANSWER_HEAD))
  console.log(`  rows: ${kinds(run)}`)
  console.log(`  bytes received ${run.bytes} · exit ${run.exit} (${run.signal ?? 'no signal'}) at ${seconds(run.exitedAtMs, run.t0)} · reader resumed at ${seconds(run.resumedAtMs, run.t0)}`)
  tally.check('the run stayed alive while its reader was stalled (nothing dropped on an exit the reader could not see)', run.aliveAfterStall)
  tally.check('the answer row reached the reader after it resumed', answerRows.length >= 1, `text rows carrying the answer: ${answerRows.length}`)
  tally.check('the outcome row is the last row and it reached the reader', outcome !== undefined && run.frames[run.frames.length - 1] === outcome, outcome === undefined ? 'no outcome row arrived' : `last row ${String(run.frames[run.frames.length - 1]?.type)}`)
  tally.check('the outcome says completed', outcome !== undefined && outcome.status === 'completed', JSON.stringify(outcome?.status))
  tally.check('every row parsed as one JSON line (no line cut in two by the stall)', !run.frames.some(f => f.type === 'unparseable'), run.frames.filter(f => f.type === 'unparseable').map(f => String(f.line)).join(' | '))
  tally.check('the process exited 0 once the rows were delivered', run.exit === 0, `exit ${run.exit} signal ${run.signal}`)
  tally.check('the exit came after the reader resumed, not before', run.exitedAtMs !== null && run.exitedAtMs >= run.resumedAtMs, `exit ${seconds(run.exitedAtMs, run.t0)} · resumed ${seconds(run.resumedAtMs, run.t0)}`)
  tally.check('no broken-pipe line on stderr (the reader never left)', !run.stderr.includes('stdout'), run.stderr.slice(0, 200) + run.readerLog.slice(0, 200))
}

tally.section('a reader that reads slowly, a tail written and the process exiting at once: the close and the outcome rows reach the reader, last and in order')
{
  const run = await runWithReader('slow')
  const types = run.frames.map(f => `${String(f.type)}${f.state !== undefined ? `:${String(f.state)}` : ''}`)
  console.log(`  rows: ${types.join(' ')}`)
  console.log(`  bytes received ${run.bytes} · exit ${run.exit} (${run.signal ?? 'no signal'}) at ${seconds(run.exitedAtMs, run.t0)}`)
  tally.check('the stream ends with the close row then the outcome row', types.length >= 2 && types[types.length - 2] === 'close:stored' && types[types.length - 1] === 'outcome', types.slice(-3).join(' '))
  tally.check('the outcome says completed and the answer rode it', run.frames[run.frames.length - 1]?.status === 'completed' && String(run.frames[run.frames.length - 1]?.answer ?? '').startsWith(ANSWER_HEAD), JSON.stringify(run.frames[run.frames.length - 1]))
  tally.check('every row parsed as one JSON line', !run.frames.some(f => f.type === 'unparseable'))
  tally.check('the process exited 0 on its own after the tail was delivered', run.exit === 0 && run.signal !== 'SIGKILL', `exit ${run.exit} signal ${run.signal}`)
}

tally.section('a reader that leaves for good: the run ends instead of waiting forever')
{
  const run = await runWithReader('close')
  console.log(`  rows: ${kinds(run)}`)
  console.log(`  bytes received ${run.bytes} · exit ${run.exit} (${run.signal ?? 'no signal'}) at ${seconds(run.exitedAtMs, run.t0)} · reader closed at ${seconds(run.resumedAtMs, run.t0)}`)
  tally.check('the run stayed alive while its reader was stalled', run.aliveAfterStall)
  tally.check('once the reader closed its end the process ended on its own (no kill needed)', run.exitedAtMs !== null && run.signal !== 'SIGKILL', `exit ${run.exit} signal ${run.signal}`)
  tally.check('the process ended within a few seconds of the reader leaving', run.exitedAtMs !== null && run.exitedAtMs - run.resumedAtMs < vshotBudgetMs(10_000), `exit ${seconds(run.exitedAtMs, run.t0)} · closed ${seconds(run.resumedAtMs, run.t0)}`)
  tally.check('a dead reader ends loudly with exit 1 (never a silent 0)', run.exit === 1, `exit ${run.exit}`)
  tally.check('stderr states the broken-stdout reason', run.stderr.includes("stdout closed before the run's output was delivered (broken pipe)"), run.stderr.slice(0, 200))
}

tally.section('a file target is unchanged: every row through close and outcome lands on disk with exit 0')
{
  const runHome = join(scratch, `home-${++homes}`)
  const cwd = join(runHome, 'work')
  const outFile = join(scratch, 'rows-out.ndjson')
  const fixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1', description: 'the quiet step' } }]
    return [{ type: 'text', text: ANSWER }]
  })
  seedScratchHome(runHome, cwd)
  const port = Number(new URL(fixture.base).port)
  const fd = openSync(outFile, 'w')
  const child: ChildProcess = spawn(NODE, [DIST, 'run', '--format', 'rows', '--mode', 'sovereign', '--model', MODEL, '--', ASK], {
    cwd,
    env: childEnv(runHome, port) as Record<string, string | undefined>,
    stdio: ['ignore', fd, 'pipe'],
  })
  const exit = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  closeSync(fd)
  await fixture.close()
  const lines = readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Frame)
  const types = lines.map(f => `${String(f.type)}${f.state !== undefined ? `:${String(f.state)}` : ''}`)
  tally.check('the file target ends with close:stored then outcome and exits 0', exit === 0 && types.length >= 2 && types[types.length - 2] === 'close:stored' && types[types.length - 1] === 'outcome' && lines[lines.length - 1]?.status === 'completed', `exit ${exit} · tail ${types.slice(-3).join(' ')}`)
}

tally.section('the seam: the exit drain waits while the reader is alive, the guard hands the caller\'s callback to the real write')
{
  const { drainPipedStdoutForExit } = await import('../../src/utils/gracefulShutdown.ts')
  const alive = { isTTY: false, writableLength: 300, destroyed: false, writable: true }
  let settled = false
  const waiting = drainPipedStdoutForExit(alive).then(result => {
    settled = true
    return result
  })
  await sleep(2_600)
  tally.check('a stalled reader whose pipe is alive is waited on past any clock (2.6 s and still waiting)', !settled)
  alive.writableLength = 0
  const result = await waiting
  tally.check('the wait ends the moment the buffer drains', result.drained && result.remainingBytes === 0)
  const gone = { isTTY: false, writableLength: 300, destroyed: true, writable: false }
  const goneResult = await drainPipedStdoutForExit(gone)
  tally.check('a reader whose pipe is gone ends the wait with the remainder counted', !goneResult.drained && goneResult.remainingBytes === 300)
  tally.check('a TTY never waits', (await drainPipedStdoutForExit({ isTTY: true, writableLength: 5, destroyed: false, writable: true })).drained)
  const guard = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'wireStdoutGuard.ts'), 'utf8')
  tally.check('the guard hands the caller\'s callback to the real write of the last forwarded line', /realWrite\(`\$\{line\}\\n`, [a-zA-Z]+\)/.test(guard) || guard.includes('realWrite(`${line}\\n`, callback'))
  const shutdownSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'gracefulShutdown.ts'), 'utf8')
  tally.check('gracefulShutdown disarms its failsafe clock before drainPipedStdoutForExit and promotes an undrained pipe to exit 1', /clearTimeout\(failsafeTimer\)[\s\S]{0,120}const stdoutDrain = await drainPipedStdoutForExit\(\)[\s\S]{0,120}!stdoutDrain\.drained/.test(shutdownSrc))
}

tally.finish()
