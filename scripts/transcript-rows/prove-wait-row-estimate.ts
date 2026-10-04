#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { LineReader, inputLine, lastOutcome, promptRow, type Frame } from '../lib/rows.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const tally = makeTally('prove-wait-row-estimate')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'wait-row-estimate-')))
console.log(`build under proof: ${DIST}`)

const { waitRow } = await import('../../src/rows/project.ts')
const { WaitRowSchema } = await import('../../src/rows/vocabulary.ts')
const { estimateRequestTokens, requestWaitToWire } = await import('../../src/services/providers/streamIdleBudget.ts')

tally.section('§1 the first-byte wait row names its prompt figure as the send-time estimate')
const scope = { sessionId: 'sess-1', turn: 1 }
const row = waitRow(scope as never, { kind: 'first-byte', cold: true, promptTokens: 55_524, model: 'Space Bunny Alpha', budgetMs: 426_629, sinceMs: 0, attempt: 1 }) as Record<string, unknown>
tally.check('the row carries prompt_tokens_estimate', row.prompt_tokens_estimate === 55_524, JSON.stringify(row))
tally.check('the row carries no field spelled like a billed count', !('prompt_tokens' in row) && !('input_tokens' in row))
tally.check('the vocabulary accepts the row', WaitRowSchema().safeParse({ ...row, seq: 3, timestamp: new Date().toISOString(), session_id: 'sess-1' }).success, JSON.stringify(WaitRowSchema().safeParse({ ...row, seq: 3, timestamp: new Date().toISOString(), session_id: 'sess-1' }).error?.issues))
tally.check('the figure is the request body\'s bytes, four to a token', estimateRequestTokens({ a: 'x'.repeat(396) }) === 101 && estimateRequestTokens(undefined) === 1)
const wire = requestWaitToWire({ kind: 'first-byte', cold: true, promptTokens: 7, model: 'm', budgetMs: 1, sinceMs: 0, attempt: 1 })
tally.check('the runner\'s status frame keeps its own spelling for the seat', wire.prompt_tokens === 7)
const seat = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'sessionSeat.ts'), 'utf8')
tally.check('the daemon seat reads the estimate back under its name', seat.includes('num(row.prompt_tokens_estimate)') && !seat.includes('num(row.prompt_tokens)'))

tally.section('§2 the built product: a rows run names the estimate on the wait and the billed usage on the step')
const ASK = 'say-hello'
const fixture = await startScriptedFixture(() => [{ type: 'text', text: 'hello' }])
const runHome = join(scratch, 'home')
const cwd = join(scratch, 'work')
seedScratchHome(runHome, cwd)
const env = childEnv(runHome, Number(new URL(fixture.base).port))
const frames = await new Promise<Frame[]>(resolve => {
  const seen: Frame[] = []
  const reader = new LineReader()
  const child = spawn(NODE, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--mode', 'sovereign'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const killer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
  child.stdout.on('data', (chunk: Buffer) => {
    for (const frame of reader.feed(chunk)) {
      seen.push(frame)
      if (frame.type === 'outcome') child.stdin.end()
    }
  })
  child.stderr.on('data', () => undefined)
  child.on('close', () => {
    clearTimeout(killer)
    seen.push(...reader.flush())
    resolve(seen)
  })
  child.stdin.write(inputLine(promptRow(ASK, { id: randomUUID() })))
})
await fixture.close()
const outcome = lastOutcome(frames)
tally.check('the run completed', outcome !== undefined && outcome.status === 'completed', JSON.stringify(outcome))
const waits = frames.filter(f => f.type === 'wait')
const firstByte = waits.find(f => f.state === 'first_byte' || f.state === 'loading')
tally.check('a first-byte wait row was written', firstByte !== undefined, JSON.stringify(waits))
tally.check('the wait row names its figure prompt_tokens_estimate and nothing spelled as a count', firstByte !== undefined && typeof firstByte.prompt_tokens_estimate === 'number' && !('prompt_tokens' in firstByte), JSON.stringify(firstByte))
const step = frames.find(f => f.type === 'step')
tally.check('the step row carries the billed usage under its own names', step !== undefined && typeof (step.usage as { input_tokens?: unknown } | undefined)?.input_tokens === 'number', JSON.stringify(step))
tally.check('no row spells prompt_tokens as a top-level figure', frames.every(f => !('prompt_tokens' in f)))

if (!KEEP) rmSync(scratch, { recursive: true, force: true })
tally.finish()
