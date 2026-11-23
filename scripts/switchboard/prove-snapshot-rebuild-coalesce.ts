#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const coalesceFix = ' — fix makeCoalescedRebuild in src/screen/concourse/route/useConcourseSnapshot.ts'

const { makeCoalescedRebuild } = await import('../../src/screen/concourse/ConcourseRoute.tsx')

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

section('C1 · no-overlap — a mid-build burst costs one rerun, never a stack')
{
  let active = 0
  let maxActive = 0
  let runs = 0
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
  const kick = makeCoalescedRebuild(async () => {
    runs++
    active++
    maxActive = Math.max(maxActive, active)
    const gate = deferred()
    gates.push(gate)
    await gate.promise
    active--
  }, () => true)

  kick()
  await tick()
  for (let i = 0; i < 12; i++) kick()
  check('the burst did not start concurrent builds', runs === 1 && maxActive === 1, `runs=${runs} maxActive=${maxActive}; a trigger during a running build must only set a pending flag, never start a second build${coalesceFix}`)
  gates[0]!.resolve()
  await tick()
  await tick()
  check('exactly ONE rerun followed the burst (12 triggers coalesced)', runs === 2, `runs=${runs}; all triggers during a build must collapse into one rerun after it settles${coalesceFix}`)
  gates[1]!.resolve()
  await tick()
  await tick()
  check('no further build after the rerun settled', runs === 2 && maxActive === 1, `runs=${runs} maxActive=${maxActive}; the pending flag must be cleared when the rerun starts, so nothing builds after it settles${coalesceFix}`)
}

section('C2 · no-dropped-trigger — the last completed build covers the last trigger')
{
  let version = 0
  const startedAt: number[] = []
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
  const kick = makeCoalescedRebuild(async () => {
    startedAt.push(version)
    const gate = deferred()
    gates.push(gate)
    await gate.promise
  }, () => true)
  const trigger = (): void => {
    version++
    kick()
  }
  trigger()
  await tick()
  trigger()
  trigger()
  gates[0]!.resolve()
  await tick()
  await tick()
  trigger()
  gates[1]!.resolve()
  await tick()
  await tick()
  gates[2]?.resolve()
  await tick()
  await tick()
  const last = startedAt.at(-1)
  check(
    'every trigger is covered: the last completed build started at the final version',
    last === version,
    `startedAt=${JSON.stringify(startedAt)} finalVersion=${version}; a trigger that arrives mid-build must still cause a later build${coalesceFix}`,
  )
  check('the coalescing did real work (fewer builds than triggers)', startedAt.length < version, `builds=${startedAt.length} triggers=${version}; triggers during a running build must be merged, not each started${coalesceFix}`)
}

section('C3 · the unmount gate — no rerun after isAlive() goes false')
{
  let alive = true
  let runs = 0
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
  const kick = makeCoalescedRebuild(async () => {
    runs++
    const gate = deferred()
    gates.push(gate)
    await gate.promise
  }, () => alive)
  kick()
  await tick()
  kick()
  alive = false
  gates[0]!.resolve()
  await tick()
  await tick()
  check('the pending rerun was suppressed by the unmount gate', runs === 1, `runs=${runs}; the pending rerun must check isAlive() before starting${coalesceFix}`)
}

section('C4 · liveness — quiescence then a new trigger builds afresh')
{
  let runs = 0
  const kick = makeCoalescedRebuild(async () => {
    runs++
  }, () => true)
  kick()
  await tick()
  await tick()
  kick()
  await tick()
  await tick()
  check('two separated triggers ran two builds', runs === 2, `runs=${runs}; after the builds settle the next trigger must start a build again (reset the running flag in a finally)${coalesceFix}`)
}


console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
