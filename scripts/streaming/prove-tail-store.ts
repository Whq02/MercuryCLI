#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-tail-store.ts — the streaming-tail store's
//  scheduler + freshness contract (src/utils/messages/streamingTailStore.ts).
//
//  Laws under proof (injected clock/timer — fully deterministic):
//   1. BYTE-EQUALITY  — any chunking through update() reproduces the source
//      exactly in BOTH read() (fresh) and the final published snapshot.
//   2. FIRST-CONTENT IMMEDIACY — null→text publishes synchronously (no timer).
//   3. CLEAR IMMEDIACY — text→null publishes synchronously.
//   4. LEADING EDGE   — a delta arriving ≥interval after the last publish
//      publishes synchronously (slow streams gain ZERO added latency).
//   5. TRAILING COALESCE — deltas inside the interval coalesce into ONE
//      trailing publish carrying the COMPLETE accumulated value.
//   6. BOUNDED PUBLISHES — an N-delta storm publishes ≤ 2 + duration/interval
//      times (never per delta).
//   7. ESC FRESHNESS  — read() sees the un-published tail at every instant.
//   8. SNAPSHOT STABILITY — getSnapshot() only changes at publish points.
//   9. NO LOST FINAL DELTA — reset()/pending-trailing always land the full
//      value; dispose() kills the timer; late updates stay read()-fresh but
//      never notify.
// ============================================================================

import { createStreamingTailStore } from '../../src/utils/messages/streamingTailStore.js'

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
      // fire due timers in order
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

// 1. byte-equality under chunkings
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
    sim.advance(100) // drain trailing
    check(`byte-equality fresh (${name})`, sim.store.read() === source)
    check(`byte-equality published (${name})`, sim.store.getSnapshot() === source)
  }
}

// 2+3. boundary immediacy
{
  const sim = makeSim()
  sim.store.update(() => 'first')
  check('first content publishes synchronously', sim.publishes.length === 1 && sim.publishes[0] === 'first')
  sim.advance(5)
  sim.store.update(() => null)
  check('clear publishes synchronously', sim.publishes.length === 2 && sim.publishes[1] === null)
  check('no timer left after boundary publishes', sim.timersPending() === 0)
}

// 4. leading edge for slow streams
{
  const sim = makeSim(40)
  sim.store.update(() => 'w1 ')
  sim.advance(90)
  sim.store.update(cur => cur + 'w2 ')
  check('slow-cadence delta publishes immediately (leading edge)', sim.publishes.length === 2)
  sim.advance(90)
  sim.store.update(cur => cur + 'w3')
  check('every slow delta zero-latency', sim.publishes.length === 3 && sim.publishes[2] === 'w1 w2 w3')
}

// 5+6. trailing coalesce + bounded publishes
{
  const sim = makeSim(40)
  // 100 deltas at 2ms apart over 200ms
  for (let i = 0; i < 100; i++) {
    sim.store.update(cur => (cur ?? '') + 'x')
    sim.advance(2)
  }
  sim.advance(60)
  const total = sim.publishes.length
  // 200ms of storm at 40ms cadence: 1 immediate + ≤ ceil(200/40)+1 trailing
  check(`storm publishes bounded (got ${total}, cap 8)`, total <= 8 && total >= 3)
  check('final trailing publish carries the COMPLETE value', sim.store.getSnapshot() === 'x'.repeat(100))
  const partials = sim.publishes.filter(p => p !== null)
  check('publishes are monotonic prefixes', partials.every((p, i) => i === 0 || p!.startsWith(partials[i - 1]!)))
}

// 7+8. esc freshness + snapshot stability between publishes
{
  const sim = makeSim(40)
  sim.store.update(() => 'a') // publish 1 (boundary)
  sim.advance(10)
  sim.store.update(cur => cur + 'b') // inside interval — coalesces
  check('read() sees the un-published tail', sim.store.read() === 'ab')
  check('snapshot stays at the last publish', sim.store.getSnapshot() === 'a')
  sim.advance(40)
  check('trailing publish lands the tail', sim.store.getSnapshot() === 'ab')
}

// 9. dispose + late updates + reset flush
{
  const sim = makeSim(40)
  sim.store.update(() => 'live')
  sim.advance(10)
  sim.store.update(cur => cur + ' tail') // pending trailing
  sim.store.reset(null)
  check('reset(null) flushes synchronously and kills the timer', sim.store.getSnapshot() === null && sim.timersPending() === 0)

  const sim2 = makeSim(40)
  sim2.store.update(() => 'x')
  sim2.advance(10)
  sim2.store.update(cur => cur + 'y')
  sim2.store.dispose()
  const before = sim2.publishes.length
  sim2.advance(100)
  check('dispose kills the pending trailing publish', sim2.publishes.length === before)
  sim2.store.update(cur => (cur ?? '') + 'z')
  check('late update stays read()-fresh, never notifies', sim2.store.read() === 'xyz' && sim2.publishes.length === before)
}

if (failures > 0) {
  console.error(`❌ FLUX tail-store: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ FLUX tail-store GREEN')
