#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/repro-p0-1-switch-erases-pending-write.ts — P0-1's
//  expect-red reproducer (untouched tree, built BEFORE the fix): opening a
//  new interview session ERASES the prior session's accepted-but-unsettled
//  write.
//
//  Mechanism:
//    · ONE module-global `saveTimer` (:79) serves every session identity;
//    · `scheduleSave()` (:101) begins with `clearTimeout(saveTimer)` — when
//      the NEXT session's first append lands inside the 150 ms debounce
//      window, the PRIOR session's pending persist is cancelled, not
//      batched. The closure capture (sessionId, events) would have written
//      the prior session correctly — the CLEAR is the loss;
//    · `flushInterviewLog()` (:129) drains only the CURRENT live session,
//      so the registered shutdown drain cannot recover the erased write.
//
//  The binding law: a timer may batch, never erase;
//  switching identity never clears another identity's accepted state.
//
//  While the defect exists this exits 3 (CHECKS_FAILED_EXIT — "still
//  reproduces"). After per-identity settlement it flips green and is
//  retained as the named regression for the class. Never part of the green
//  gate (the repro-* idiom).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, waitUntil } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-p01')
const t = checker()

const store = await import('../../src/services/interview/store.ts')

const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)

function durableSessions(): Record<string, { events: unknown[] }> {
  if (!existsSync(logPath)) return {}
  const raw = JSON.parse(readFileSync(logPath, 'utf8')) as { data?: { sessions?: unknown }; sessions?: unknown }
  const sessions = (raw.sessions ?? raw.data?.sessions ?? {}) as Record<string, { events: unknown[] }>
  return sessions
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — control: a lone session\'s pending debounced write settles via the drain')
{
  store._resetInterviewForProofs()
  const a = store.openInterviewSession({ mission: 'lone session', atMs: 1 })
  await store.flushInterviewLog()
  await waitUntil(() => durableSessions()[a] !== undefined)
  t.check('the lone session settled durably (the drain works when identity never switched)',
    durableSessions()[a] !== undefined)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the defect: a session switch inside the debounce window erases the prior identity\'s accepted write')
{
  store._resetInterviewForProofs()
  // Session A accepts one event (session-opened) — its persist is armed on
  // the 150 ms debounce, NOT yet settled.
  const a = store.openInterviewSession({ mission: 'prior identity A', atMs: 2 })
  // Session B opens synchronously (same tick — no await between): B's first
  // append runs scheduleSave() → clearTimeout(A's pending persist).
  const b = store.openInterviewSession({ mission: 'next identity B', atMs: 3 })
  // The shutdown drain runs — it can only see the LIVE session (B).
  await store.flushInterviewLog()
  // Give any stray timer its chance (observed-ready, count-based — never a
  // fixed verdict window: extra attempts cost time, never the verdict).
  await waitUntil(() => durableSessions()[a] !== undefined, { tries: 80, everyMs: 10 })
  const sessions = durableSessions()
  t.check('the switched-to session B settled durably (premise: persistence itself works)',
    sessions[b] !== undefined)
  t.check(
    'switching identity never cancels the prior identity\'s accepted write — A settles durably too',
    sessions[a] !== undefined,
    'A\'s pending persist was clearTimeout-erased by B\'s first scheduleSave; the drain then saw only B',
  )
}

t.finish('repro-p0-1-switch-erases-pending-write')
