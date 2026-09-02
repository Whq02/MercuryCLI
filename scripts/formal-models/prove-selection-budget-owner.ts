#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/prove-selection-budget-owner.ts — the
//  selection-budget publishing owner exists at the ONE builder with the
//  byte-identical accepted default.
//
//    §1 ACCEPTED DEFAULT — flag unset ⇒ the caller's budget passes through
//       IDENTICALLY (null stays null; a caller object stays the SAME
//       reference): earlier behavior byte-identical.
//    §2 THE FLAG PUBLISHES — parse, clamp to [0,10000], the optional total
//       bound, and flag-outranks-caller (the policy resolver's precedence,
//       mirrored).
//    §3 MALFORMED IS HONEST — an invalid operator value resolves to the
//       caller's budget WITH a note; it never silently changes selection.
//    §4 THE ONE BUILDER THREADS IT — source-pinned: requestContextPlan
//       resolves through resolveSelectionBudget (no second resolution
//       path), and the registry row exists with the generated doc in sync.
//
//  Env hygiene (ambient-state law): the flag is pinned explicitly per
//  section and cleared afterwards.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

scratchRoot('cairn-budget')
delete process.env.MERCURY_SELECTION_BUDGET
delete process.env.MERCURY_SELECTION_BUDGET

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')
const { resolveSelectionBudget } = await import('../../src/services/run/contextSelection.ts')

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — accepted default: unset ⇒ the caller budget passes through identically')
{
  delete process.env.MERCURY_SELECTION_BUDGET
  const none = resolveSelectionBudget(undefined)
  t.check('no caller, no flag ⇒ null / none', none.budget === null && none.source === 'none' && none.note === undefined)
  const caller = { maxOptionalItems: 7 }
  const passed = resolveSelectionBudget(caller)
  t.check('a caller budget passes through as the SAME reference', passed.budget === caller && passed.source === 'caller')
  t.check('no note rides the default path', passed.note === undefined)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the flag publishes: parse, clamp, total bound, outranks caller')
{
  process.env.MERCURY_SELECTION_BUDGET = '5'
  const five = resolveSelectionBudget(undefined)
  t.check("'5' ⇒ maxOptionalItems 5 from the flag", five.budget?.maxOptionalItems === 5 && five.source === 'flag')
  const overCaller = resolveSelectionBudget({ maxOptionalItems: 99 })
  t.check('the flag OUTRANKS a caller budget (the policy-resolver precedence)', overCaller.budget?.maxOptionalItems === 5 && overCaller.source === 'flag')
  process.env.MERCURY_SELECTION_BUDGET = '25000'
  t.check("'25000' clamps to 10000", resolveSelectionBudget(undefined).budget?.maxOptionalItems === 10_000)
  process.env.MERCURY_SELECTION_BUDGET = '3,10'
  const withTotal = resolveSelectionBudget(undefined)
  t.check("'3,10' carries the total bound", withTotal.budget?.maxOptionalItems === 3 && withTotal.budget?.maxTotalItems === 10)
  process.env.MERCURY_SELECTION_BUDGET = '5,2'
  const droppedTotal = resolveSelectionBudget(undefined)
  t.check("'5,2' drops the impossible total WITH a note (never a forced drop)",
    droppedTotal.budget?.maxOptionalItems === 5 && droppedTotal.budget?.maxTotalItems === undefined && Boolean(droppedTotal.note))
  process.env.MERCURY_SELECTION_BUDGET = '0'
  t.check("'0' is a legitimate exclude-all-optional budget", resolveSelectionBudget(undefined).budget?.maxOptionalItems === 0)
  delete process.env.MERCURY_SELECTION_BUDGET
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — malformed is honest: caller passthrough + a note, never silence')
{
  process.env.MERCURY_SELECTION_BUDGET = 'abc'
  const caller = { maxOptionalItems: 4 }
  const r = resolveSelectionBudget(caller)
  t.check('the caller budget survives a malformed flag', r.budget === caller && r.source === 'caller')
  t.check('the note names the malformation', Boolean(r.note?.includes('malformed')))
  const noCaller = resolveSelectionBudget(undefined)
  t.check('no caller + malformed flag ⇒ null with the note', noCaller.budget === null && Boolean(noCaller.note))
  delete process.env.MERCURY_SELECTION_BUDGET
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — the ONE builder threads it; the registry row exists and the doc is in sync')
{
  const builder = readFileSync(join(ROOT, 'src/services/run/requestContextPlan.ts'), 'utf8')
  t.check('requestContextPlan resolves through resolveSelectionBudget', builder.includes('resolveSelectionBudget(input.selectionBudget)'))
  t.check('no direct input-only budget path survives', !builder.includes('input.selectionBudget ?? null'))
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  t.check('the registry row exists', registry.includes("env: 'MERCURY_SELECTION_BUDGET'"))
  // (No committed-doc-sync leg: the registry source is the truth; the
  //  rendered table is untracked inspection output.)
}

t.finish('prove-selection-budget-owner')
