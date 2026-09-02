#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/repro-p0-2-settlement-swallowed.ts — P0-2's
//  expect-red reproducer (untouched tree, built BEFORE the fix): a REQUIRED
//  final interview write can degrade while the caller and the shutdown
//  drain believe the drain completed.
//
//  Mechanism:
//    · `persist()` (:113-126) catches every write failure → `logError` only —
//      no receipt, no retryable state;
//    · `flushInterviewLog()` (:129-135) awaits that persist and resolves
//      void REGARDLESS of settlement;
//    · `registerCleanup(() => flushInterviewLog())` (:97) therefore always
//      observes a "completed" drain.
//
//  The binding law: accepted is not durable until
//  publication settles — the caller can OBSERVE settlement
//  (accepted → settled | degraded), and the last degradation is observable.
//
//  Deterministic failure injection (ambient-state law: everything under the
//  scratch root): the store's parent directory path is occupied
//  by a REGULAR FILE, so the durable publish fails with ENOTDIR on every
//  attempt — no timing, no fault-injection env.
//
//  While the defect exists this exits 3 (CHECKS_FAILED_EXIT). After
//  typed settlement receipts it flips green and is retained as the named
//  regression. Never part of the green gate (the repro-* idiom).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-p02')
const t = checker()

// Occupy the store's parent directory path with a regular file BEFORE the
// store ever touches it: interview/<projectKey>.json now has an
// unresolvable parent (ENOTDIR) — a deterministic durable-write failure.
writeFileSync(guardWrite(root, join(root, 'interview')), 'not a directory — cairn P0-2 fault seam')

const store = await import('../../src/services/interview/store.ts')

const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the defect: a failed required drain is invisible at the flush seam')
{
  store._resetInterviewForProofs()
  store.openInterviewSession({ mission: 'doomed session', atMs: 1 })
  let threw = false
  let receipt: unknown
  try {
    receipt = await store.flushInterviewLog()
  } catch {
    threw = true
  }
  t.check('(premise) the durable write genuinely failed — no log file exists',
    !existsSync(logPath))
  t.check(
    'a failed REQUIRED drain is observable to the caller (typed settlement receipt or throw)',
    threw || (receipt !== undefined && receipt !== null),
    'flushInterviewLog resolved void — persist() swallowed the failure into logError; the registered shutdown cleanup believes the drain completed',
  )
}

t.finish('repro-p0-2-settlement-swallowed')
