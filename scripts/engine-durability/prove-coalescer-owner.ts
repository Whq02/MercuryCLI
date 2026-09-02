#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-coalescer-owner.ts — (defect G) regression pins
//  for the two laws prove-projection-freshness cannot see.
//
//  The M0 reproducer drives the coalescer's SEMANTICS directly (one trailing
//  run, nothing after release) and ratchets the migration by import. It does
//  not, and should not, grow new checks — it is the frozen
//  oracle. These are the laws that only show up once the owner is wired
//  into a real engine:
//
//    §1  Released lanes are TERMINAL. stopEngine releases the lane, so the
//        handle must be dropped and a fresh one minted on the next start. Keep
//        it and every later poke is a silent no-op — the engine reports no
//        error and simply never refreshes again. This is the same failure
//        class as "lane latched after one idle pump", which also
//        surfaced as silence rather than a fault.
//    §2  The snapshot names the trigger generation its gather observed, so
//        freshness is checkable from outside the engine instead of inferred.
//    §3  ONE owner. Four inlined copies of this algorithm existed before
//        substrate/serialGeneration.ts; the workbench, CurrentWork and
//        telemetry copies are now gone. The remaining two are pinned WITH
//        REASONS and the ratchet fails in both directions, so neither a new
//        copy nor a silently-retired baseline entry passes unnoticed.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, waitUntil } from './harness.ts'

scratchRoot('coalescer')
const t = checker()

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const projection = await import('../../src/services/workbench/projection.ts')
const version = (): number => projection.getWorkbenchSnapshot()?.version ?? 0
const stamp = (): number | undefined => projection.getWorkbenchSnapshot()?.gatherGeneration

t.section('§1 — a stopped engine mints a FRESH lane on restart')
{
  projection._resetWorkbenchForTesting()
  const unsub1 = projection.subscribeWorkbench(() => {})
  const filled = await waitUntil(() => version() > 0)
  t.check('first engine start reached its initial fill', filled, `version=${version()}`)
  const afterFirst = version()

  // Dropping the last listener stops the engine, which releases the lane.
  unsub1()
  const unsub2 = projection.subscribeWorkbench(() => {})
  const restarted = await waitUntil(() => version() > afterFirst)
  t.check(
    'a second engine start still refreshes (the released-lane trap)',
    restarted,
    `version ${afterFirst} → ${version()}`,
  )
  unsub2()
  projection._resetWorkbenchForTesting()
}

t.section('§2 — the snapshot names the trigger generation it observed')
{
  projection._resetWorkbenchForTesting()
  const unsub = projection.subscribeWorkbench(() => {})
  const filled = await waitUntil(() => version() > 0)
  t.check('engine reached its initial fill', filled, `version=${version()}`)

  const first = stamp()
  t.check(
    'the initial fill carries a gather generation',
    typeof first === 'number' && first >= 1,
    `gatherGeneration=${String(first)}`,
  )

  // Two pokes, the second landing while the first gather is in flight: the
  // trailing gather is the one that stamps, so the final stamp names the LAST
  // accepted trigger rather than the one that started the burst.
  const before = version()
  projection.pokeWorkbench()
  projection.pokeWorkbench()
  await waitUntil(() => version() >= before + 2)
  const later = stamp()
  t.check(
    'the stamp advances to the last accepted trigger',
    typeof later === 'number' && typeof first === 'number' && later > first,
    `gatherGeneration ${String(first)} → ${String(later)}`,
  )

  unsub()
  projection._resetWorkbenchForTesting()
}

t.section('§3 — one owner: the inline-copy ratchet')
{
  // Pinned deliberately, with the reason recorded here:
  //
  //   daemon/scribeDispatchBridge.ts — a HARDENED variant rather than a naive
  //     copy: it carries disposal, a held-mail retry timer, and an explicit
  //     re-entry for a trigger landing in the trailing unread-check window,
  //     which the plain loop drops. Folding it onto the lane would lose those
  //     behaviours, so it stays until it has a reproducer of its own.
  const PINNED = [
    'src/daemon/scribeDispatchBridge.ts',
  ]

  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(p)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const src = readFileSync(p, 'utf8')
      if (/rerun\s*=\s*true/.test(src) && /while \(rerun/.test(src)) found.push(p)
    }
  }
  walk('src')
  found.sort()

  // Details are printed on PASS lines too, so they state the OBSERVATION
  // rather than the remediation — a pass that reads like a warning is noise
  // during gate triage.
  for (const f of PINNED) {
    t.check(
      `baseline entry still carries its inline copy: ${f}`,
      found.includes(f),
      found.includes(f) ? 'matches' : 'GONE — retire the entry from PINNED in this prover',
    )
  }
  for (const f of found) {
    t.check(
      `no unpinned inline copy: ${f}`,
      PINNED.includes(f),
      PINNED.includes(f)
        ? 'pinned with a reason'
        : 'NEW — route it through serialCoalescer, or pin it here with a reason',
    )
  }

  const MIGRATED = [
    'src/services/workbench/projection.ts',
    'src/services/workbench/currentWork.ts',
    'src/state/telemetryBus.ts',
  ]
  for (const f of MIGRATED) {
    const src = readFileSync(f, 'utf8')
    t.check(`${f} routes through the coalescing owner`, src.includes('serialCoalescer'))
    t.check(
      `${f} kept no inline copy behind`,
      !/rerun\s*=\s*true/.test(src),
      /rerun\s*=\s*true/.test(src) ? 'the migration left the old latch in place' : 'clean',
    )
  }
}

t.finish('prove-coalescer-owner')
