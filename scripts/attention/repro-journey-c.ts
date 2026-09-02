#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-c.ts — Journey C reproducer.
//  Pins rows (EXPECT-RED until Wave A lands).
//
//  The gap this repro pins: command-queue exposes enqueue/dequeue/remove/restage
//  but NO sequence-aware replace-next — so a surface wanting "change the next
//  queued instruction" has no honest owner route, and nothing can answer
//  `target-moved` when the instruction already started. The law: replace-next
//  routes THROUGH input-core/command-queue.ts (QUEUE-LAWS stay green), never
//  through a view-local copy.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('Journey C — replace-next RETIRED with the delivery law (steer-removal)')
const q = (await import('../../src/input-core/command-queue.ts')) as Record<string, unknown>
// Under instant delivery no queued entry exists to replace; the verb died
// with the attention re-route. POISON: its return is a deliberate contract
// change and re-trues the dispatch-actions prover with it.
t.check(
  'command-queue exports NO replaceNext any more',
  typeof q.replaceNext === 'undefined',
)

t.section('Journey C — the peek/change-next surface is bound (RV-07/RV-08)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  // The board's peek + change-next verbs retired with the WORK panel:
  // the registry must not carry
  // them; the panel's expand row is the drill that remains.
  t.check(
    "the Action Graph no longer names 'board:peek' (retired with the WORK panel)",
    !/['"]board:peek['"]/.test(ag) && /['"]prompts:expand['"]/.test(ag),
    'the retired peek verb is still registered',
  )
  t.check(
    "the Action Graph no longer names 'board:change-next' (retired with the WORK panel)",
    !/['"]board:change-next['"]/.test(ag),
    'the retired change-next verb is still registered',
  )
}

t.finish('repro-journey-c')
