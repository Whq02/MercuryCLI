#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-projection-freshness.ts — M0 reproducer for defect
//  G, the dropped mid-gather trigger.
//
//  ORACLE: hold gather A between reads, emit trigger B, complete A — a second
//  gather occurs automatically. A burst may coalesce, but the final snapshot
//  must include the last accepted trigger, and a release mid-gather must leave
//  no state update or subscription behind.
//
//  What the code does today — useCurrentWork in
//  src/services/workbench/currentWork.ts:
//      const refresh = () => {
//        if (pending) return
//
//  A trigger arriving mid-gather is dropped with no rerun recorded, and the
//  hook owns no timers. Missed invariant: freshness — the rendered snapshot
//  stays behind until some unrelated later event. Partial mitigation today:
//  the workbench engine's 20s heartbeat repaints workbench-fed fields while
//  subscribed; run- and task-fed fields have no such floor, which is why this
//  is a correctness gap rather than latency.
//
//  The correct policy ALREADY EXISTS ~100 lines away, inlined in pokeWorkbench
//  (src/services/workbench/projection.ts):
//      if (refreshing) { rerun = true; return }
//
//      do { rerun = false; await refreshOnce() } while (rerun)
//  §4 below drives that real code as the positive control: it is the semantics
//  the extracted owner must preserve, and it is why this defect is an
//  inconsistency rather than a missing design.
//
//  DELIBERATE SCOPE NOTE: the
//  hook itself is not driven in-process. This repo's Ink renderer cannot host
//  React hooks under `bun run` (one React copy, null dispatcher — the render
//  aborts), which is precisely why the repo's law routes TUI correctness
//  through real PTY captures. So the SEMANTICS are proven behaviourally at the
//  owner (§1–§3), the template is pinned behaviourally (§4), the migration is
//  proven mechanically (§5), and the rendered surface gets its capture at the
//  close. No claim here rests on source wiring alone.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker, scratchRoot, waitUntil } from './harness.ts'

scratchRoot('freshness')
const t = checker()

const barrier = await import('./barrier.ts')

// ── the owner the fix must extract ─────────────────────────────────────────
type CoalescerModule = {
  serialCoalescer?: (run: () => Promise<void>) => {
    poke: () => void
    settled: () => Promise<void>
    release: () => void
    generation: () => number
  }
}
let coalescer: CoalescerModule | null = null
try {
  coalescer = (await import('../../src/services/workbench/serialCoalescer.ts')) as CoalescerModule
} catch {
  coalescer = null
}

t.section('§1 — a serial-coalescing owner exists')
t.check(
  'src/services/workbench/serialCoalescer.ts exports serialCoalescer()',
  typeof coalescer?.serialCoalescer === 'function',
  coalescer === null ? 'module not present' : 'export missing',
)

t.section('§2 — a trigger arriving mid-run produces exactly one trailing run')
if (typeof coalescer?.serialCoalescer === 'function') {
  let runs = 0
  let entered!: () => void
  const hasEntered = new Promise<void>(res => {
    entered = res
  })
  let open!: () => void
  const gate = new Promise<void>(res => {
    open = res
  })
  const c = coalescer.serialCoalescer(async () => {
    runs++
    if (runs === 1) {
      entered()
      await gate
    }
  })
  c.poke()
  await hasEntered
  // 100 triggers land while the first run is still in flight.
  for (let i = 0; i < 100; i++) c.poke()
  await barrier.microturns()
  t.check('the burst did not fan out into concurrent runs', runs === 1, `runs=${runs}`)
  open()
  await c.settled()
  t.check('exactly one trailing run followed the burst', runs === 2, `runs=${runs}`)
  c.release()
} else {
  t.check('the burst did not fan out into concurrent runs', false, 'no owner to drive')
  t.check('exactly one trailing run followed the burst', false, 'no owner to drive')
}

t.section('§3 — release mid-run leaves nothing pending')
if (typeof coalescer?.serialCoalescer === 'function') {
  let runs = 0
  let entered!: () => void
  const hasEntered = new Promise<void>(res => {
    entered = res
  })
  let open!: () => void
  const gate = new Promise<void>(res => {
    open = res
  })
  const c = coalescer.serialCoalescer(async () => {
    runs++
    if (runs === 1) {
      entered()
      await gate
    }
  })
  c.poke()
  await hasEntered
  c.poke()
  c.release()
  open()
  await c.settled()
  await barrier.microturns()
  t.check('no trailing run survives a release', runs === 1, `runs=${runs}`)
} else {
  t.check('no trailing run survives a release', false, 'no owner to drive')
}

// ── §4 positive control: the in-repo template already has these semantics ──
t.section('§4 — pokeWorkbench (the template) honours a mid-refresh trigger')
{
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()

  const projection = await import('../../src/services/workbench/projection.ts')
  projection._resetWorkbenchForTesting()
  const unsub = projection.subscribeWorkbench(() => {})
  const version = (): number => projection.getWorkbenchSnapshot()?.version ?? 0

  const filled = await waitUntil(() => version() > 0)
  t.check('the workbench engine reached its initial fill', filled, `version=${version()}`)
  const before = version()

  // The second poke lands while the first refresh is still awaiting its gather.
  projection.pokeWorkbench()
  projection.pokeWorkbench()
  await waitUntil(() => version() >= before + 2)
  const after = version()

  t.check(
    'the mid-refresh trigger produced a trailing refresh',
    after - before >= 2,
    `version ${before} → ${after}`,
  )
  unsub()
  projection._resetWorkbenchForTesting()
}

// ── §5 migration ratchet: the async projections consume the owner ──────────
t.section('§5 — the audited async projections use the coalescing owner')
{
  const consumers = [
    'src/services/workbench/currentWork.ts',
    'src/services/workbench/projection.ts',
  ]
  for (const file of consumers) {
    let src = ''
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      /* reported by the check below */
    }
    t.check(
      `${file} routes its refresh through serialCoalescer`,
      src.includes('serialCoalescer'),
      src === '' ? 'unreadable' : 'no import of the coalescing owner',
    )
  }
}

t.finish('prove-projection-freshness')
