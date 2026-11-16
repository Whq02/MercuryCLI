#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostRunner } from '../lib/runnerHost.ts'
import { childEnv, makeTally, scratchWorld, seedScratchHome, startScriptedFixture } from '../lib/scratchSeat.ts'
import { describeSeat, seatRuntime } from '../lib/seatLauncher.ts'

const tally = makeTally('prove-context-figure-follows-a-turn')
const check = tally.check
const section = tally.section
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

type Figure = { used: number | null; source: string | null }
const figureOf = (facts: unknown): Figure => {
  const context = ((facts as { usage?: { context?: Record<string, unknown> } }).usage?.context ?? {}) as Record<string, unknown>
  const used = context['used_tokens'] ?? context['usedTokens'] ?? null
  const source = context['fill_source'] ?? context['fillSource'] ?? null
  return { used: typeof used === 'number' ? used : null, source: typeof source === 'string' ? source : null }
}
const say = (figure: Figure | null): string => (figure === null ? 'not read' : `${figure.used === null ? 'no figure' : figure.used} (${figure.source ?? 'no source'})`)

const HOLD_MS = 2500
const { runHome, cwd } = scratchWorld('context-follows')
seedScratchHome(runHome, cwd)
const note = join(cwd, 'note.txt')
writeFileSync(note, 'a line the turn reads three times over\n')
const fixture = await startScriptedFixture(
  req => (req.step < 3 ? [{ type: 'text', text: `context-follows: reading, round ${req.step + 1}` }, { type: 'tool_use', name: 'Read', input: { file_path: note } }] : [{ type: 'text', text: 'context-follows: the turn is answered' }]),
  { answerDelayMs: req => (req.step > 0 ? HOLD_MS : 0) },
)
const seat = seatRuntime(join(runHome, '..'))
console.log(`    the runner: ${describeSeat(seat)}`)
const runner = hostRunner({
  node: seat.exe,
  dist: seat.script,
  home: runHome,
  cwd,
  argv: ['--session-id', randomUUID()],
  env: { ...(childEnv(runHome, Number(new URL(fixture.base).port)) as Record<string, string | undefined>), HOME: runHome, MERCURY_CONCOURSE_WORKER: '1', MERCURY_SESSION_KIND: 'oculus' },
})
runner.onAsk(() => ({ behavior: 'allow' }) as never)

const heldAt = async (round: number): Promise<Figure | null> => {
  const deadline = Date.now() + 60_000
  while (fixture.requests.length < round + 1 && Date.now() < deadline) await nap(50)
  if (fixture.requests.length < round + 1) return null
  await nap(300)
  return figureOf(await runner.request('session/facts', {} as never, 20_000))
}

let before: Figure | null = null
let first: Figure | null = null
let second: Figure | null = null
let third: Figure | null = null
let after: Figure | null = null
let again: Figure | null = null
let turned = ''
try {
  await runner.initialize()
  before = figureOf(await runner.request('session/facts', {} as never, 20_000))
  await runner.prompt('context-follows: read the note three times, then answer in a word')
  first = await heldAt(1)
  second = await heldAt(2)
  third = await heldAt(3)
  const outcome = await runner.waitFor('the one turn', row => row.type === 'outcome', 120_000)
  turned = String(outcome.status)
  after = figureOf(await runner.request('session/facts', {} as never, 20_000))
  await nap(400)
  again = figureOf(await runner.request('session/facts', {} as never, 20_000))
} catch (error) {
  turned = String(error).slice(0, 300)
}

section('S1 a session nothing has answered yet names no figure, and its first turn does')
check('before the first turn the facts name no context figure', before !== null && before.used === null, say(before))
check('while the first turn waits for its second reply the facts name a figure, read from the first reply', first !== null && first.used !== null && first.used > 0 && first.source === 'usage', `after reply 1: ${say(first)}`)
check('and while it waits for its third and its fourth', second !== null && second.used !== null && second.used > 0 && third !== null && third.used !== null && third.used > 0, `after reply 2: ${say(second)}; after reply 3: ${say(third)}`)
check('the figure does not run backwards inside the turn', first !== null && second !== null && third !== null && first.used !== null && second.used !== null && third.used !== null && second.used >= first.used && third.used >= second.used, `${say(first)}, ${say(second)}, ${say(third)}`)

section('S2 the turn over, the figure is the settled one and stands')
check('the turn completed with its three reads', turned === 'completed' && fixture.requests.length === 4, `the turn: ${turned}; ${fixture.requests.length} request(s); ${runner.stderr().slice(-200)}`)
check('after the turn the facts name a figure no smaller than the last one read inside it', after !== null && after.used !== null && third !== null && third.used !== null && after.used >= third.used, `inside: ${say(third)}; after: ${say(after)}`)
check('and asked again it is the same figure', after !== null && again !== null && after.used === again.used && after.source === again.source, `${say(after)} then ${say(again)}`)

console.log(`    the figures: before ${say(before)}; inside the turn ${say(first)}, ${say(second)}, ${say(third)}; after ${say(after)}`)
await runner.stop(3_000)
await fixture.close()
tally.finish()
