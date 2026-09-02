#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-serial-lane.ts — the serial generation lane's own
//  contract.
//
//  The lane is the owner every durable write in the run kernel now goes
//  through, so its contract has to hold on its own terms, not only as observed
//  through the coordinator:
//
//   §1 SERIAL + TRAILING — commits never overlap, and a generation accepted
//      while a commit is in flight always gets its own commit afterwards.
//   §2 COALESCING — a burst collapses to bounded work, and the FINAL commit
//      carries the last accepted value.
//   §3 FAILURE IS A STATE — a failed commit leaves its generation
//      accepted-but-uncommitted, reports degraded with the reason, and a later
//      settle() lands the same or a newer generation.
//   §4 TERMINATION — settle() always returns. A producer that accepts faster
//      than the writer commits must not hold it open: the loop re-reads
//      `accepted` after every await, so without a per-pump budget the promise
//      never resolves and every caller that awaits it hangs — including the
//      turn generator's finally, which now awaits its terminal drain.
//   §5 RELEASE IS TERMINAL AND HONEST — a commit already in flight finishes,
//      and a value accepted after release is REPORTED rather than recorded as
//      a generation that can never land.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot } from './harness.ts'

scratchRoot('lane')
const t = checker()

const { serialGenerationLane } = await import('../../src/substrate/serialGeneration.ts')

/** One macrotask — a controlled scheduling turn, never a wall-clock sleep. */
const turn = (): Promise<void> => new Promise<void>(res => setImmediate(res))

// ── §1 serial + trailing ────────────────────────────────────────────────────
t.section('§1 — commits are serial, and a mid-flight arrival still commits')
{
  const commits: number[] = []
  let inFlight = 0
  let overlapped = false
  let entered!: () => void
  const hasEntered = new Promise<void>(res => {
    entered = res
  })
  let open!: () => void
  const gate = new Promise<void>(res => {
    open = res
  })

  const lane = serialGenerationLane<number>({
    name: 'keel-serial',
    commit: async value => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      if (commits.length === 0) {
        entered()
        await gate
      }
      commits.push(value)
      inFlight -= 1
    },
  })

  lane.accept(1)
  lane.poke()
  await hasEntered
  lane.accept(2) // arrives while generation 1 is committing
  open()
  const settled = await lane.settle()

  t.check('no two commits overlapped', !overlapped)
  t.check('the mid-flight arrival got its own commit', commits.includes(2), `commits=[${commits}]`)
  t.check('the lane reports settled', settled.state === 'settled', `state=${settled.state}`)
  t.check(
    'committed equals accepted',
    settled.committed === settled.accepted,
    `${settled.committed}/${settled.accepted}`,
  )
}

// ── §2 coalescing ───────────────────────────────────────────────────────────
t.section('§2 — a burst coalesces to bounded work carrying the last value')
{
  const commits: number[] = []
  let entered!: () => void
  const hasEntered = new Promise<void>(res => {
    entered = res
  })
  let open!: () => void
  const gate = new Promise<void>(res => {
    open = res
  })
  const lane = serialGenerationLane<number>({
    name: 'keel-coalesce',
    commit: async value => {
      if (commits.length === 0) {
        entered()
        await gate
      }
      commits.push(value)
    },
  })

  lane.accept(0)
  lane.poke()
  await hasEntered
  for (let i = 1; i <= 100; i++) lane.accept(i)
  open()
  await lane.settle()

  t.check('100 accepts did not become 100 commits', commits.length <= 3, `commits=${commits.length}`)
  t.check('the last accepted value is what landed', commits.at(-1) === 100, `last=${commits.at(-1)}`)
}

// ── §3 failure is a state ───────────────────────────────────────────────────
t.section('§3 — a failed commit is reported and retried, never marked clean')
{
  let failNext = true
  const commits: number[] = []
  const lane = serialGenerationLane<number>({
    name: 'keel-degrade',
    commit: async value => {
      if (failNext) throw new Error('disk is unavailable')
      commits.push(value)
    },
  })

  lane.accept(7)
  const first = await lane.settle()
  t.check('the failed commit reports degraded', first.state === 'degraded', `state=${first.state}`)
  t.check('the reason names the failure', (first.reason ?? '').includes('disk is unavailable'))
  t.check('committed did not advance', first.committed === 0, `committed=${first.committed}`)
  t.check('an attempt was counted', first.attempts >= 1, `attempts=${first.attempts}`)

  failNext = false
  const second = await lane.settle()
  t.check('a later settle lands the generation', second.state === 'settled', `state=${second.state}`)
  t.check('the retried value is the accepted one', commits.at(-1) === 7, `commits=[${commits}]`)
}

// ── §4 termination under a producer that outruns the writer ─────────────────
t.section('§4 — settle() returns even when accepts outpace commits')
{
  let commits = 0
  let stop = false
  const lane = serialGenerationLane<number>({
    name: 'keel-outrun',
    commit: async () => {
      commits += 1
      await turn()
    },
  })

  // A producer that accepts once per macrotask — at least one new generation
  // per commit, indefinitely. This is the shape that keeps the trailing-commit
  // loop's exit condition permanently false.
  const producer = (async () => {
    let n = 0
    while (!stop) {
      lane.accept(++n)
      await turn()
    }
  })()

  lane.accept(0)
  const settled = await lane.settle()
  stop = true
  await producer

  t.check('settle() returned rather than hanging', true, `commits=${commits}`)
  t.check(
    'it reported its state truthfully rather than claiming settled',
    settled.state === 'pending' || settled.state === 'settled',
    `state=${settled.state} ${settled.committed}/${settled.accepted}`,
  )
  t.check('work was actually done', commits > 0, `commits=${commits}`)

  const drained = await lane.settle()
  t.check('a follow-up settle also returns', drained.accepted >= drained.committed)
}

// ── §5 release is terminal and honest ───────────────────────────────────────
t.section('§5 — release finishes in-flight work and reports post-release accepts')
{
  const commits: number[] = []
  let entered!: () => void
  const hasEntered = new Promise<void>(res => {
    entered = res
  })
  let open!: () => void
  const gate = new Promise<void>(res => {
    open = res
  })
  const lane = serialGenerationLane<number>({
    name: 'keel-release',
    commit: async value => {
      if (commits.length === 0) {
        entered()
        await gate
      }
      commits.push(value)
    },
  })

  lane.accept(1)
  lane.poke()
  await hasEntered
  let released = false
  const releasing = lane.release().then(s => {
    released = true
    return s
  })
  await turn()
  t.check('release waits for the commit already in flight', !released)
  open()
  const final = await releasing
  t.check('the in-flight commit landed', commits.includes(1), `commits=[${commits}]`)
  t.check('the lane is released', final.released)

  lane.accept(99)
  lane.poke()
  await turn()
  const after = lane.state()
  t.check(
    'a value accepted after release is reported, not silently recorded',
    after.state === 'degraded',
    `state=${after.state} — a released lane starts no commits, so a silent 'pending' would never resolve`,
  )
  t.check('it did not commit', !commits.includes(99), `commits=[${commits}]`)
}

// ── §6 a work-free pump must not disable the lane ──────────────────────────
t.section('§6 — a settle() with nothing to do leaves the lane usable')
{
  // The shape that killed it: an async function whose body completes WITHOUT
  // awaiting runs its finally synchronously, before the assignment that stores
  // its promise. Guarding the pump on that handle meant one work-free settle()
  // — an ordinary read-only turn, where nothing was ever accepted — latched a
  // resolved promise that nothing cleared, and every later pump short-circuited
  // on it. The lane then reported `pending` with zero attempts forever: neither
  // committed nor degraded, so no receipt surfaced it.
  const commits: number[] = []
  const lane = serialGenerationLane<number>({
    name: 'keel-idle-pump',
    commit: async value => {
      commits.push(value)
    },
  })

  const idle = await lane.settle()
  t.check('an idle settle reports clean', idle.state === 'clean', `state=${idle.state}`)

  lane.accept(1)
  const afterWork = await lane.settle()
  t.check(
    'the lane still commits after an idle settle',
    afterWork.state === 'settled' && commits.includes(1),
    `state=${afterWork.state} commits=[${commits}]`,
  )

  // Same shape via poke() and via a settle() that is already caught up.
  const caughtUp = await lane.settle()
  t.check('a caught-up settle reports settled', caughtUp.state === 'settled')
  lane.accept(2)
  lane.poke()
  await new Promise<void>(res => setImmediate(res))
  const afterPoke = await lane.settle()
  t.check(
    'the lane still commits after a caught-up settle',
    afterPoke.committed === afterPoke.accepted && commits.includes(2),
    `${afterPoke.committed}/${afterPoke.accepted} commits=[${commits}]`,
  )
}

t.finish('prove-serial-lane')
