#!/usr/bin/env bun

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
    check(`byte-equality fresh (${name})`, sim.store.read() === source)
    check(`byte-equality published (${name})`, sim.store.getSnapshot() === source)
  }
}

{
  const sim = makeSim()
  sim.store.update(() => 'first')
  check('first content publishes synchronously', sim.publishes.length === 1 && sim.publishes[0] === 'first')
  sim.advance(5)
  sim.store.update(() => null)
  check('clear publishes synchronously', sim.publishes.length === 2 && sim.publishes[1] === null)
  check('no timer left after boundary publishes', sim.timersPending() === 0)
}

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

{
  const sim = makeSim(40)
  for (let i = 0; i < 100; i++) {
    sim.store.update(cur => (cur ?? '') + 'x')
    sim.advance(2)
  }
  sim.advance(60)
  const total = sim.publishes.length
  check(`storm publishes bounded (got ${total}, cap 8)`, total <= 8 && total >= 3)
  check('final trailing publish carries the COMPLETE value', sim.store.getSnapshot() === 'x'.repeat(100))
  const partials = sim.publishes.filter(p => p !== null)
  check('publishes are monotonic prefixes', partials.every((p, i) => i === 0 || p!.startsWith(partials[i - 1]!)))
}

{
  const sim = makeSim(40)
  sim.store.update(() => 'a')
  sim.advance(10)
  sim.store.update(cur => cur + 'b')
  check('read() sees the un-published tail', sim.store.read() === 'ab')
  check('snapshot stays at the last publish', sim.store.getSnapshot() === 'a')
  sim.advance(40)
  check('trailing publish lands the tail', sim.store.getSnapshot() === 'ab')
}

{
  const sim = makeSim(40)
  sim.store.update(() => 'live')
  sim.advance(10)
  sim.store.update(cur => cur + ' tail')
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
