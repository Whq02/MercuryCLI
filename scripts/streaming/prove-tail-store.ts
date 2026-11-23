#!/usr/bin/env bun

import { createStreamingTailStore } from '../../src/engine/message-shapes/streamingTailStore.js'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

type Sim = {
  store: ReturnType<typeof createStreamingTailStore>
  advance: (ms: number) => void
  publishes: (string | null)[]
  timersPending: () => number
}
function makeSim(intervalMs = 40): Sim {
  let clock = 0
  type T = { at: number; fn: () => void; dead: boolean }
  const timers: T[] = []
  const store = createStreamingTailStore({
    intervalMs,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t: T = { at: clock + ms, fn, dead: false }
      timers.push(t)
      return t
    },
    clearTimer: h => {
      ;(h as T).dead = true
    },
  })
  const publishes: (string | null)[] = []
  store.subscribe(() => publishes.push(store.getSnapshot()))
  return {
    store,
    publishes,
    timersPending: () => timers.filter(t => !t.dead && t.at > clock).length,
    advance: ms => {
      const target = clock + ms
      for (;;) {
        const due = timers
          .filter(t => !t.dead && t.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (!due) break
        clock = due.at
        due.dead = true
        due.fn()
      }
      clock = target
    },
  }
}

console.log('── FLUX S2 tail-store laws ──')

{
  const source = 'alpha beta gamma\ndelta epsilon ⟦S1⟧ zeta\nfinal tail without newline'
  for (const [name, size] of [
    ['char', 1],
    ['tri', 3],
    ['word-ish', 7],
  ] as const) {
    const sim = makeSim()
    for (let i = 0; i < source.length; i += size) {
      sim.store.update(cur => (cur ?? '') + source.slice(i, i + size))
      sim.advance(2)
    }
    sim.advance(100)
    check(`byte-equality fresh (${name})`, sim.store.read() === source, 'read() lost or reordered text; fix update() in createStreamingTailStore, src/engine/message-shapes/streamingTailStore.ts')
    check(`byte-equality published (${name})`, sim.store.getSnapshot() === source, 'the published snapshot differs from the full text after the timers ran; the trailing publish must carry the complete value, see publishNow in src/engine/message-shapes/streamingTailStore.ts')
  }
}

{
  const sim = makeSim()
  sim.store.update(() => 'first')
  check('first content publishes synchronously', sim.publishes.length === 1 && sim.publishes[0] === 'first', 'the first content must notify subscribers at once; see update and transition in src/engine/message-shapes/streamingTailStore.ts')
  sim.advance(5)
  sim.store.update(() => null)
  check('clear publishes synchronously', sim.publishes.length === 2 && sim.publishes[1] === null, 'update to null must publish at once; see transition in src/engine/message-shapes/streamingTailStore.ts')
  check('no timer left after boundary publishes', sim.timersPending() === 0, 'a trailing timer is still pending after a publish at a boundary; clear it in transition, src/engine/message-shapes/streamingTailStore.ts')
}

{
  const sim = makeSim(40)
  sim.store.update(() => 'w1 ')
  sim.advance(90)
  sim.store.update(cur => cur + 'w2 ')
  check('slow-cadence delta publishes immediately (leading edge)', sim.publishes.length === 2, 'an update after more than intervalMs of quiet must publish at once instead of waiting for a timer; see the intervalMs test in src/engine/message-shapes/streamingTailStore.ts')
  sim.advance(90)
  sim.store.update(cur => cur + 'w3')
  check('every slow delta zero-latency', sim.publishes.length === 3 && sim.publishes[2] === 'w1 w2 w3', 'a slow delta was delayed or lost; see the intervalMs test in src/engine/message-shapes/streamingTailStore.ts')
}

{
  const sim = makeSim(40)
  for (let i = 0; i < 100; i++) {
    sim.store.update(cur => (cur ?? '') + 'x')
    sim.advance(2)
  }
  sim.advance(60)
  const total = sim.publishes.length
  check(`storm publishes bounded (got ${total}, cap 8)`, total <= 8 && total >= 3, 'a burst of updates must publish between 3 and 8 times; check how update schedules the trailing publish in src/engine/message-shapes/streamingTailStore.ts')
  check('final trailing publish carries the COMPLETE value', sim.store.getSnapshot() === 'x'.repeat(100), 'the last publish after the burst is not the complete value; see publishNow in src/engine/message-shapes/streamingTailStore.ts')
  const partials = sim.publishes.filter(p => p !== null)
  check('publishes are monotonic prefixes', partials.every((p, i) => i === 0 || p!.startsWith(partials[i - 1]!)), 'a published value is not an extension of the one before it; publishes must only grow while streaming, see src/engine/message-shapes/streamingTailStore.ts')
}

{
  const sim = makeSim(40)
  sim.store.update(() => 'a')
  sim.advance(10)
  sim.store.update(cur => cur + 'b')
  check('read() sees the un-published tail', sim.store.read() === 'ab', 'read() must return the newest value even before it is published; see read in src/engine/message-shapes/streamingTailStore.ts')
  check('snapshot stays at the last publish', sim.store.getSnapshot() === 'a', 'the snapshot moved before the trailing publish; getSnapshot must change only on a publish, see src/engine/message-shapes/streamingTailStore.ts')
  sim.advance(40)
  check('trailing publish lands the tail', sim.store.getSnapshot() === 'ab', 'the trailing publish did not fire after intervalMs; see the timer in update, src/engine/message-shapes/streamingTailStore.ts')
}

{
  const sim = makeSim(40)
  sim.store.update(() => 'live')
  sim.advance(10)
  sim.store.update(cur => cur + ' tail')
  sim.store.reset(null)
  check('reset(null) flushes synchronously and kills the timer', sim.store.getSnapshot() === null && sim.timersPending() === 0, 'reset(null) must publish null at once and clear the pending timer; see reset in src/engine/message-shapes/streamingTailStore.ts')

  const sim2 = makeSim(40)
  sim2.store.update(() => 'x')
  sim2.advance(10)
  sim2.store.update(cur => cur + 'y')
  sim2.store.dispose()
  const before = sim2.publishes.length
  sim2.advance(100)
  check('dispose kills the pending trailing publish', sim2.publishes.length === before, 'a publish fired after dispose(); dispose must clear the pending timer, see src/engine/message-shapes/streamingTailStore.ts')
  sim2.store.update(cur => (cur ?? '') + 'z')
  check('late update stays read()-fresh, never notifies', sim2.store.read() === 'xyz' && sim2.publishes.length === before, 'after dispose(), update must still change read() but must not notify subscribers; see src/engine/message-shapes/streamingTailStore.ts')
}

if (failures > 0) {
  console.error(`❌ FLUX tail-store: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ FLUX tail-store GREEN')
