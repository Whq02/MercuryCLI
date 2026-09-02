#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/repro-p1-3-quadratic-fold-unbounded-events.ts —
//  P1-3's expect-red reproducer (untouched tree, built BEFORE the fix):
//  the interview fold's dedupe is O(n) PER EVENT (⇒ O(n²) rebuild), and a
//  session's own event history has NO bound (MAX_SESSIONS caps sessions,
//  never events within a session).
//
//  Mechanism:
//    · `state.seenEventIds.includes(event.eventId)` (:243) — a linear scan
//      of every previously folded id, per event;
//    · `[...state.seenEventIds, event.eventId]` (:244) — a full array copy
//      per event (same class; the includes scan is the one instrumented
//      here because it is observable without touching the fold);
//    · `rebuildInterview` (:364) folds each event ⇒ the scan work is
//      quadratic in the session's own history;
//    · store.ts `MAX_SESSIONS = 10` (:39) bounds the SESSION count only —
//      nothing reaps or checkpoints events inside a session.
//
//  The binding law: near-O(1) live dedupe, linear
//  rebuild; every writer has a bound and a reaper — a session cap does not
//  bound per-session arrays.
//
//  STRUCTURAL measurement (structural-read-first; the session-load law):
//  §1 counts SCANNED ELEMENTS via an Array.prototype.includes instrument —
//  a deterministic operation count, never a duration, so machine load can
//  never change the verdict.
//
//  While the defect exists this exits 3 (CHECKS_FAILED_EXIT). After
//  near-O(1) dedupe + bounded checkpoint/compaction it flips green and is
//  retained as the named regression. Never part of the green gate.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, waitUntil } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-p13')
const t = checker()

const { rebuildInterview } = await import('../../src/services/interview/contracts.ts')
const store = await import('../../src/services/interview/store.ts')
type AnyInterviewEvent = Parameters<typeof rebuildInterview>[0][number]

function syntheticEvents(n: number): AnyInterviewEvent[] {
  const events: AnyInterviewEvent[] = [
    {
      kind: 'session-opened',
      eventId: 'ie_open',
      atMs: 1,
      sessionId: 'is_p13',
      mission: 'bounded-history law',
    } as AnyInterviewEvent,
  ]
  for (let i = 1; i < n; i++) {
    events.push({ kind: 'navigated', eventId: `ie_${i}`, atMs: 1 + i, target: 'review' } as AnyInterviewEvent)
  }
  return events
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — dedupe work grows ~linearly with history (operation count, not time)')
{
  // Post-fix mechanism: the shared-set fold arm does O(1) dedupe ops
  // per event. Pre-fix, the includes-scan cost n²/2 comparisons — the
  // exit-3 receipts for that state ride the; this section
  // now guards the achieved linear class by the same operation-count method
  // the resume-bounds gate enforces.
  const contracts = await import('../../src/services/interview/contracts.ts')
  t.check('(premise) the shared-set fold arm exists', typeof contracts.foldInterviewShared === 'function')
  class CountingSet extends Set<string> {
    ops = 0
    override has(v: string): boolean {
      this.ops++
      return super.has(v)
    }
    override add(v: string): this {
      this.ops++
      return super.add(v) as this
    }
  }
  const opsFor = (n: number): number => {
    const seen = new CountingSet()
    let s = { ...contracts.emptyInterviewState(), seenEventIds: seen }
    for (const e of syntheticEvents(n)) s = contracts.foldInterviewShared(s, e, seen)
    return seen.ops
  }
  const ops100 = opsFor(100)
  const ops400 = opsFor(400)
  const ratio = ops400 / Math.max(1, ops100)
  t.check(
    '4× the events costs ≤ ~8× the dedupe ops (near-O(1) live dedupe / O(n) rebuild law)',
    ops100 > 0 && ratio <= 8,
    `ops@100=${ops100} ops@400=${ops400} ratio=${ratio.toFixed(1)} (the pre-cairn quadratic scan ⇒ ~16×)`,
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — a single session\'s durable event history is bounded (a session cap is not an event bound)')
{
  store._resetInterviewForProofs()
  const K = 1200
  store.openInterviewSession({ mission: 'unbounded-history session', atMs: 1 })
  for (let i = 1; i < K; i++) {
    store.appendInterviewEvent({ kind: 'navigated', eventId: `ie_live_${i}`, atMs: 1 + i, target: 'review' } as never)
  }
  await store.flushInterviewLog()
  const logPath = join(
    root,
    'interview',
    `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
  )
  await waitUntil(() => existsSync(logPath))
  const raw = JSON.parse(readFileSync(logPath, 'utf8')) as { data?: { sessions?: unknown }; sessions?: unknown }
  const sessions = (raw.sessions ?? raw.data?.sessions ?? {}) as Record<string, { events: unknown[] }>
  const entry = Object.values(sessions)[0]
  t.check('(premise) the session settled durably', entry !== undefined)
  const retained = entry ? entry.events.length : -1
  t.check(
    `a ${K}-event session retains a BOUNDED durable history (checkpoint/compaction reaps the tail)`,
    retained >= 0 && retained < K,
    `retained=${retained} — every event kept; MAX_SESSIONS=10 bounds sessions, nothing bounds events inside one`,
  )
}

t.finish('repro-p1-3-quadratic-fold-unbounded-events')
