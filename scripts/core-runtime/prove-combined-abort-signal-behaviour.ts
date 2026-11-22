#!/usr/bin/env bun
import { createCombinedAbortSignal } from '../../src/utils/combinedAbortSignal.ts'
import { untilAsync } from '../lib/untilAsync.ts'

const WHERE = 'createCombinedAbortSignal in src/utils/combinedAbortSignal.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

section('§1 with nothing to follow')
{
  const combined = createCombinedAbortSignal(undefined)
  check('it hands back a live signal and a cleanup function', combined.signal instanceof AbortSignal && !combined.signal.aborted && typeof combined.cleanup === 'function')
  combined.cleanup()
  combined.cleanup()
  check('cleanup may be called, and called again, and the signal stays live', !combined.signal.aborted)
}

section('§2 following one signal or two')
{
  const first = new AbortController()
  const combined = createCombinedAbortSignal(first.signal)
  check('live while the signal is live', !combined.signal.aborted)
  first.abort()
  check('aborted as soon as it aborts', combined.signal.aborted, `see ${WHERE}`)
}
{
  const first = new AbortController()
  const second = new AbortController()
  const combined = createCombinedAbortSignal(first.signal, { signalB: second.signal })
  let heard = 0
  combined.signal.addEventListener('abort', () => heard++)
  second.abort()
  check('with two, the second alone aborts it', combined.signal.aborted && !first.signal.aborted)
  first.abort()
  check('and its listeners hear it once, however many of the two abort', heard === 1, String(heard))
}
{
  const second = new AbortController()
  const combined = createCombinedAbortSignal(undefined, { signalB: second.signal })
  second.abort()
  check('the second may be the only one given', combined.signal.aborted)
}
{
  const aborted = new AbortController()
  aborted.abort()
  const live = new AbortController()
  check('a first signal that had already aborted gives a signal that is aborted from the start', createCombinedAbortSignal(aborted.signal).signal.aborted)
  check('so does a second one', createCombinedAbortSignal(live.signal, { signalB: aborted.signal }).signal.aborted && !live.signal.aborted)
  const combined = createCombinedAbortSignal(aborted.signal, { timeoutMs: 5 })
  combined.cleanup()
  check('and its cleanup is harmless', combined.signal.aborted)
}

section('§3 cleanup lets go of what it followed')
{
  const first = new AbortController()
  const second = new AbortController()
  const combined = createCombinedAbortSignal(first.signal, { signalB: second.signal })
  combined.cleanup()
  first.abort()
  second.abort()
  check('after cleanup, neither signal aborts it', !combined.signal.aborted, `see ${WHERE}`)
}

section('§4 a time limit')
{
  const started = Date.now()
  const combined = createCombinedAbortSignal(undefined, { timeoutMs: 40 })
  check('live at first', !combined.signal.aborted)
  const fired = await untilAsync(() => combined.signal.aborted, 5_000, 5)
  check('aborted by itself once the limit has passed, and not before it', fired && Date.now() - started >= 35, `${Date.now() - started} ms; see ${WHERE}`)
}
{
  const combined = createCombinedAbortSignal(undefined, { timeoutMs: 40 })
  combined.cleanup()
  const fired = await untilAsync(() => combined.signal.aborted, 200, 10)
  check('cleanup before the limit stops the clock: it never aborts', !fired)
}
{
  const first = new AbortController()
  const combined = createCombinedAbortSignal(first.signal, { timeoutMs: 10_000 })
  first.abort()
  check('a signal that aborts before the limit aborts it at once', combined.signal.aborted)
  const live = new AbortController()
  const limited = createCombinedAbortSignal(live.signal, { timeoutMs: 30 })
  const fired = await untilAsync(() => limited.signal.aborted, 5_000, 5)
  check('a limit that passes first aborts it and leaves the followed signal live', fired && !live.signal.aborted)
}

if (failures > 0) {
  console.error(`\nprove-combined-abort-signal-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-combined-abort-signal-behaviour: all green')
