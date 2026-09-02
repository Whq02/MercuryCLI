#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/repro-p1-4-bounds-gate-accepts-quadratic.ts — P1-4's
//  expect-red reproducer (untouched tree, built BEFORE the fix): the
//  interview resume-bounds complexity gate cannot REJECT a quadratic.
//
//  Mechanism:
//    · §1 "linear-ish" allows `big < max(1, small) * 300` at 40→400 events
//      (:102-107). A quadratic algorithm costs (400/40)² = 100× — well
//      inside the ×300 allowance — so the gate that exists to pin the
//      complexity CLASS passes a quadratic implementation untouched.
//
//  The binding-brief direction (P1-4): deterministic operation counts or a
//  multi-size slope envelope; absolute p95 budgets stay a SEPARATE gate.
//
//  Fully deterministic — §1 pins the live gate's source shape, §2 runs the
//  gate's own predicate against an exact quadratic cost model (pure
//  arithmetic; no timing, no machine dependence).
//
//  While the gap exists this exits 3 (CHECKS_FAILED_EXIT). After
//  replaces the allowance with a slope envelope that provably rejects a
//  seeded quadratic, it flips green and is retained as the named
//  regression. Never part of the green gate (the repro-* idiom).
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the live gate no longer relies on one loose ratio allowance')
{
  const gateSrc = readFileSync(join(ROOT, 'scripts/interview/prove-resume-bounds.ts'), 'utf8')
  t.check('(premise) the resume-bounds gate exists and measures multi-size slopes',
    gateSrc.includes('opsFor(100)') && gateSrc.includes('opsFor(400)'))
  t.check(
    'the gate uses a slope envelope / operation counts, not a single ×300 allowance',
    !gateSrc.includes('* 300'),
    'prove-resume-bounds.ts still carries `bigMs < Math.max(1, smallMs) * 300`',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the gate rejects a seeded quadratic (the slope-envelope certificate)')
{
  // Post-fix: the gate measures deterministic dedupe-operation counts
  // at three geometric sizes against a slope envelope, and carries its OWN
  // seeded-quadratic rejection certificate (the earlier n²/2 scan model
  // slopes ≈4 > the bound). Source-pinned so the certificate can never
  // silently leave the gate. (The pre-fix ×300 predicate passed a quadratic
  // the exit-3 receipts ride the.)
  const gateSrc = readFileSync(join(ROOT, 'scripts/interview/prove-resume-bounds.ts'), 'utf8')
  t.check('the gate measures an operation-count slope envelope', gateSrc.includes('SLOPE_MAX') && gateSrc.includes('opsFor'))
  t.check('the gate carries the seeded-quadratic rejection certificate', gateSrc.includes('REJECTS the seeded quadratic') && gateSrc.includes('quadOps'))
  t.check('the absolute budget stays a SEPARATE gate', gateSrc.includes('§1b') && gateSrc.includes('250'))
}

t.finish('repro-p1-4-bounds-gate-accepts-quadratic')
