#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-snapshot-rebuild-coalesce.ts — the board's
//  snapshot rebuilds coalesce: one active build, at most one pending rerun,
//  no trigger dropped.
//
//  Every trigger (draft keystrokes, the obligation/draft/project/slot
//  subscriptions, the delta watcher, the 15 s tick, peek and resident
//  changes) starts a FULL buildConcourseSnapshot; the sequence fence only
//  dropped stale RESULTS, so typing overlapped concurrent board scans. The
//  coalescer (makeCoalescedRebuild) pins:
//
//   C1  no-overlap — across a mid-build burst of triggers, at most ONE
//       build is ever active, and the burst costs exactly one rerun;
//   C2  no-dropped-trigger — every trigger's state version is observed by
//       some completed build (the last completed build started at/after
//       the last trigger);
//   C3  the unmount gate — a settle with isAlive()=false runs no rerun;
//   C4  liveness — after quiescence a new trigger starts a fresh build;
//   C5  (source pins) the route's rebuild IS the coalescer, the buildSeq
//       stale-result fence survives as the belt, and the trigger sites
//       still funnel through rebuild.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-snapshot-rebuild-coalesce.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

const { makeCoalescedRebuild } = await import('../../src/components/concourse/ConcourseRoute.tsx')

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
  for (let i = 0; i < 12; i++) kick() // the typing burst, mid-build
  check('the burst did not start concurrent builds', runs === 1 && maxActive === 1, `runs=${runs} maxActive=${maxActive}`)
  gates[0]!.resolve()
  await tick()
  await tick()
  check('exactly ONE rerun followed the burst (12 triggers coalesced)', runs === 2, `runs=${runs}`)
  gates[1]!.resolve()
  await tick()
  await tick()
  check('no further build after the rerun settled', runs === 2 && maxActive === 1, `runs=${runs} maxActive=${maxActive}`)
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
  trigger() // v1 → build 1 starts, sees v1
  await tick()
  trigger() // v2 mid-build
  trigger() // v3 mid-build
  gates[0]!.resolve()
  await tick()
  await tick()
  trigger() // v4 — arrives while the RERUN is active
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
    `startedAt=${JSON.stringify(startedAt)} finalVersion=${version}`,
  )
  check('the coalescing did real work (fewer builds than triggers)', startedAt.length < version, `builds=${startedAt.length} triggers=${version}`)
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
  kick() // pending
  alive = false // the route unwinds before the build settles
  gates[0]!.resolve()
  await tick()
  await tick()
  check('the pending rerun was suppressed by the unmount gate', runs === 1, `runs=${runs}`)
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
  check('two separated triggers ran two builds', runs === 2, `runs=${runs}`)
}

section('C5 · source pins — the route rebuild IS the coalescer; fence and triggers intact')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/components/concourse/ConcourseRoute.tsx'), 'utf8')
  check('rebuild is built from makeCoalescedRebuild', /const rebuild = useMemo\(\s*\(\) =>\s*makeCoalescedRebuild\(async \(\) => \{/.test(src))
  check('the buildSeq stale-result fence survives inside the build body', /const seq = \+\+buildSeq\.current[\s\S]{0,700}seq !== buildSeq\.current/.test(src))
  check(
    'the trigger sites still funnel through rebuild (draft sub, tick, watcher, peek, resident)',
    src.includes('subscribeConcourseDraft(rebuild)') &&
      src.includes('setInterval(rebuild, 15_000)') &&
      /watcher = fs\.watch\([\s\S]{0,900}rebuild\(\)/.test(src) &&
      /setPeek: \(sessionId: string\) => \{[\s\S]{0,200}rebuild\(\)/.test(src) &&
      /noteResident: [\s\S]{0,300}rebuild\(\)/.test(src),
  )
  check('the coalescer build body catches internally (runBuild never rejects)', /makeCoalescedRebuild\(async \(\) => \{[\s\S]{0,300}try \{[\s\S]{0,2200}\} catch \(e\) \{/.test(src))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
