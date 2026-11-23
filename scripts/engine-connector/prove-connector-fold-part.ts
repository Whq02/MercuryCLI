#!/usr/bin/env bun
import type { FoldStatusV1 } from '../../src/engine/compaction/foldStatus.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { FoldPart } = await import('../../src/engine/connector/daemon/fold.ts')
const { FOLD_EXIT_LINGER_MS } = await import('../../src/engine/compaction/foldStatus.ts')
type FoldStatus = FoldStatusV1

let failures = 0
const WHERE = 'the part under test is FoldPart in src/engine/connector/daemon/fold.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

type Timer = { at: number; run: () => void; dead: boolean }
const timers: Timer[] = []
let clock = 100_000
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now }
const g = globalThis as Record<string, unknown>
g.setTimeout = (run: () => void, ms = 0) => {
  const timer: Timer = { at: clock + ms, run, dead: false }
  timers.push(timer)
  const handle = { timer, unref: () => handle }
  return handle
}
g.clearTimeout = (handle: { timer?: Timer } | null | undefined) => {
  if (handle?.timer !== undefined) handle.timer.dead = true
}
Date.now = () => clock
const advance = (ms: number): void => {
  clock += ms
  for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
    if (timer.dead || timer.at > clock) continue
    timer.dead = true
    timer.run()
  }
}
const armed = (): number => timers.filter(timer => !timer.dead).length

const record = (extra: Partial<FoldStatus> = {}): FoldStatus => ({ schema: 1, trigger: 'auto', startedAtMs: clock, stages: ['summarising', 'restoring'], stage: 'summarising', fill: 0.4, summaryTokens: 10, summaryCapTokens: 100, attempt: 1, ...extra })
function part(): { fold: InstanceType<typeof FoldPart>; seen: { wakes: number; recomputes: number } } {
  const seen = { wakes: 0, recomputes: 0 }
  const fold = new FoldPart({ recomputeLive: () => void seen.recomputes++ })
  fold.subscribeFold(() => void seen.wakes++)
  return { fold, seen }
}

section('§1 a fold that runs, then exits: the record stands, lingers, and leaves')
{
  const { fold, seen } = part()
  check('with no fold: nothing to show, and nothing reads as still running', fold.fold() === null && fold.stillRuns() === true)
  const running = record()
  fold.setLiveFold(running)
  check('a running fold is shown, wakes the listeners once and asks for no recompute (the word already ranks)', fold.fold() === running && seen.wakes === 1 && seen.recomputes === 0 && fold.stillRuns() === true)
  fold.setLiveFold(record())
  check('the same record read again wakes nobody', seen.wakes === 1)
  fold.setLiveFold(record({ stage: 'restoring', fill: 0.9 }))
  check('a moved record wakes the listeners', seen.wakes === 2 && fold.fold()?.stage === 'restoring')
  const exited = record({ stage: 'restoring', exit: 'landed', endedAtMs: clock })
  fold.setLiveFold(exited)
  check('the exit is shown, no longer runs, and asks for one recompute', fold.fold() === exited && fold.stillRuns() === false && seen.recomputes === 1 && seen.wakes === 3)
  advance(FOLD_EXIT_LINGER_MS - 1)
  check(`the exit still stands ${FOLD_EXIT_LINGER_MS - 1} ms after it ended`, fold.fold() === exited && seen.wakes === 3)
  advance(1)
  check(`at ${FOLD_EXIT_LINGER_MS} ms the linger is over: the listeners wake and nothing is shown`, fold.fold() === null && seen.wakes === 4)
  fold.setLiveFold(null)
  check('the record leaving after its linger wakes the listeners, asks for a recompute (nothing reads as running again) and shows nothing', fold.fold() === null && seen.wakes === 5 && seen.recomputes === 2 && fold.stillRuns() === true)
}

section('§2 an exit that ended long ago, and a fold that runs again')
{
  const { fold, seen } = part()
  const old = record({ exit: 'failed', endedAtMs: clock - 60_000, reason: 'the summary was refused' })
  fold.setLiveFold(old)
  check('an exit that ended a minute ago is shown until the next turn of the timers', fold.fold() === old && armed() === 1)
  advance(0)
  check('…and then is over', fold.fold() === null && seen.wakes === 2)
  const again = record({ attempt: 2 })
  fold.setLiveFold(again)
  check('a fold that runs again is shown at once (the linger of the old exit does not hide it)', fold.fold() === again && fold.stillRuns() === true && seen.recomputes === 2)
  const ended = record({ attempt: 2, exit: 'cancelled' })
  fold.setLiveFold(ended)
  fold.setLiveFold(record({ attempt: 3 }))
  advance(FOLD_EXIT_LINGER_MS)
  check('a fold that starts while an exit lingers clears that linger: no late wake hides it', fold.fold()?.attempt === 3 && armed() === 0)
}

section('§3 the manual fold: its record is kept for a while after it leaves')
{
  const { fold, seen } = part()
  const manual = record({ trigger: 'manual' })
  fold.setLiveFold(manual)
  fold.setLiveFold(null)
  check('a manual fold whose record leaves is still shown (the latch)', fold.fold() === manual && seen.wakes === 2)
  advance(FOLD_EXIT_LINGER_MS - 1)
  check('…for the whole linger', fold.fold() === manual)
  advance(1)
  check('…and then the latch lets go and wakes the listeners', fold.fold() === null && seen.wakes === 3)
  const auto = record()
  fold.setLiveFold(auto)
  fold.setLiveFold(null)
  check('an automatic fold whose record leaves is not kept', fold.fold() === null)
  fold.setLiveFold(record({ trigger: 'manual' }))
  fold.setLiveFold(null)
  const next = record({ startedAtMs: clock + 1 })
  fold.setLiveFold(next)
  advance(FOLD_EXIT_LINGER_MS)
  check('a fold that starts while a latch stands takes its place, and the latch never fires', fold.fold() === next && armed() === 0)
}

section('§4 the turn goes to rest under a fold that still runs')
{
  const { fold, seen } = part()
  fold.dropRunningAtIdle()
  check('with no fold nothing is dropped and nobody wakes', fold.fold() === null && seen.wakes === 0)
  fold.setLiveFold(record())
  fold.dropRunningAtIdle()
  check('a running automatic fold is dropped and the listeners wake', fold.fold() === null && seen.wakes === 2 && seen.recomputes === 0)
  const manual = record({ trigger: 'manual' })
  fold.setLiveFold(manual)
  fold.dropRunningAtIdle()
  check('a running manual fold is dropped into the latch: still shown', fold.fold() === manual && seen.wakes === 4)
  advance(FOLD_EXIT_LINGER_MS)
  check('…until the latch lets go', fold.fold() === null && seen.wakes === 5)
  const exited = record({ exit: 'landed', endedAtMs: clock })
  fold.setLiveFold(exited)
  const wakes = seen.wakes
  fold.dropRunningAtIdle()
  check('a fold that has its exit is not dropped: its linger shows it', fold.fold() === exited && seen.wakes === wakes)
}

section('§5 the listeners')
{
  const { fold, seen } = part()
  let second = 0
  const off = fold.subscribeFold(() => void second++)
  fold.setLiveFold(record())
  off()
  fold.setLiveFold(record({ fill: 0.5 }))
  check('a listener that left is not woken; the one that stayed is', second === 1 && seen.wakes === 2)
  fold.subscribeFold(() => {
    throw new Error('a listener that throws')
  })
  fold.setLiveFold(record({ fill: 0.6 }))
  check('a listener that throws does not stop the others', seen.wakes === 3)
}

g.setTimeout = real.setTimeout
g.clearTimeout = real.clearTimeout
Date.now = real.now
console.log(failures === 0 ? '\nprove-connector-fold-part: the part holds' : `\nprove-connector-fold-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
