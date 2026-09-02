#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker, scratchRoot } from './harness.ts'

scratchRoot('lane')
const t = checker()

const { serialGenerationLane } = await import('../../src/substrate/serialGeneration.ts')

const turn = (): Promise<void> => new Promise<void>(res => setImmediate(res))

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
  lane.accept(2)
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

t.section('§6 — a settle() with nothing to do leaves the lane usable')
{
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
