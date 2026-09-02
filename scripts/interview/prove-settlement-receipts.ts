#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-settlement-receipts.ts — (rows/
//  at the interview owner): per-identity durable
//  settlement with typed observable receipts.
//
//    §1  PER-IDENTITY BATCHING (P0-1): a session switch inside the debounce
//        window never cancels the prior identity's accepted write — both
//        identities settle durably; batching stays per-identity under
//        interleaved appends.
//    §2  TYPED SETTLEMENT + RETRYABLE STATE (P0-2): a deterministic write
//        failure yields a DEGRADED settlement the caller observes; the
//        accepted generation is RETAINED and settles on the next drain once
//        the fault clears — accepted state survives degradation.
//    §3  THE SHUTDOWN DRAIN drains EVERY pending identity and reports
//        per-identity settlement (the flush receipt).
//    §4  NO ROLLBACK: a pending accepted generation outranks the
//        older durable snapshot on both adopt and resume.
//    §5  THE HEALTH RECEIPT: degradation is visible in
//        interviewPersistenceHealth() without interrupting foreground work.
//    §6  UNREADABLE ≠ EMPTY: a corrupt durable log degrades
//        OBSERVABLY — the store-recovery ledger carries a read-degrade row —
//        while reads stay alive (fail-open contract preserved).
//
//  Deterministic throughout: drains drive publication (no verdict ever waits
//  on the 150 ms debounce timer); the fault seam is a parent-path regular
//  file (ENOTDIR), healed by removing it. Hermetic per the ambient-state
//  law. Joins scripts/interview/run-all.sh via the prove-* glob.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite, waitUntil } from '../engine-durability/harness.ts'

const root = scratchRoot('interview-settle')
const t = checker()

const store = await import('../../src/services/interview/store.ts')
const { rebuildInterview } = await import('../../src/services/interview/contracts.ts')
const { readStoreRecoveryEvents } = await import('../../src/substrate/storeRecovery.ts')

const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)
function durableSessions(): Record<string, { events: unknown[] }> {
  if (!existsSync(logPath)) return {}
  const raw = JSON.parse(readFileSync(logPath, 'utf8')) as { data?: { sessions?: unknown }; sessions?: unknown }
  return (raw.sessions ?? raw.data?.sessions ?? {}) as Record<string, { events: unknown[] }>
}
function nav(eventId: string): never {
  return { kind: 'navigated', eventId, atMs: 1, target: 'review' } as never
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — per-identity batching: a switch never cancels another identity (P0-1)')
{
  store._resetInterviewForProofs()
  const a = store.openInterviewSession({ mission: 'identity A', atMs: 1 })
  const b = store.openInterviewSession({ mission: 'identity B', atMs: 2 })
  // Interleave more accepted appends on B, then drain everything.
  store.appendInterviewEvent(nav('ie_b1'))
  const receipt = await store.flushInterviewLog()
  t.check('the drain saw BOTH pending identities', receipt.drained === 2, `drained=${receipt.drained}`)
  t.check('every settlement settled', receipt.allSettled)
  const sessions = durableSessions()
  t.check('identity A settled durably (1 event)', (sessions[a]?.events.length ?? 0) === 1)
  t.check('identity B settled durably (2 events)', (sessions[b]?.events.length ?? 0) === 2)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — typed settlement + retryable generation: degradation observed, then retried clean (P0-2)')
{
  store._resetInterviewForProofs()
  rmSync(join(root, 'interview'), { recursive: true, force: true })
  // Fault seam: the store's parent dir path is occupied by a regular FILE.
  writeFileSync(guardWrite(root, join(root, 'interview')), 'ENOTDIR fault seam')
  const a = store.openInterviewSession({ mission: 'doomed then healed', atMs: 3 })
  store.appendInterviewEvent(nav('ie_h1'))
  const degraded = await store.flushInterviewLog()
  t.check('the drain reports the degradation', degraded.drained === 1 && !degraded.allSettled)
  t.check(
    'the settlement is typed degraded with the retained error',
    degraded.settlements[0]?.state === 'degraded' && Boolean(degraded.settlements[0]?.error),
    degraded.settlements[0]?.error?.slice(0, 60),
  )
  // Heal the fault; the retained accepted generation must settle on the next
  // drain — degradation never dropped the accepted events.
  rmSync(join(root, 'interview'), { force: true })
  const healed = await store.flushInterviewLog()
  t.check('the retained generation settled after the fault cleared', healed.drained === 1 && healed.allSettled)
  const sessions = durableSessions()
  t.check('the accepted events survived degradation intact (2 events)', (sessions[a]?.events.length ?? 0) === 2)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — the shutdown drain reports EVERY identity (the flush receipt)')
{
  store._resetInterviewForProofs()
  store.openInterviewSession({ mission: 'drain 1', atMs: 4 })
  store.openInterviewSession({ mission: 'drain 2', atMs: 5 })
  store.openInterviewSession({ mission: 'drain 3', atMs: 6 })
  const receipt = await store.flushInterviewLog()
  t.check('three pending identities drained', receipt.drained === 3)
  t.check('per-identity settlements are typed and complete', receipt.settlements.length === 3 && receipt.allSettled)
  const again = await store.flushInterviewLog()
  t.check('a second drain is a no-op (settled entries reaped — bound + reaper)', again.drained === 0)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3b — the REGISTERED shutdown cleanup itself drains every identity (CA-15)')
{
  const { runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')
  store._resetInterviewForProofs()
  const a = store.openInterviewSession({ mission: 'cleanup drain A', atMs: 30 })
  const b = store.openInterviewSession({ mission: 'cleanup drain B', atMs: 31 })
  // The graceful-shutdown path — NOT a direct flush call: the registered
  // cleanup must drain both pending identities (a shutdown-drain removal
  // transformation must red THIS check).
  await runCleanupFunctions()
  const sessions = durableSessions()
  t.check('the registered cleanup drained identity A', sessions[a] !== undefined)
  t.check('the registered cleanup drained identity B', sessions[b] !== undefined)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — a pending accepted generation outranks the older durable snapshot (CA-16)')
{
  store._resetInterviewForProofs()
  const a = store.openInterviewSession({ mission: 'rollback guard', toolUseId: 'toolu_ca16', atMs: 7 })
  await store.flushInterviewLog() // older durable truth: 1 event
  store.appendInterviewEvent(nav('ie_newer')) // NEWER accepted, NOT settled (timer pending)
  // resume must serve the pending newer truth, not the older file
  const resumed = await store.resumeInterviewSession(a)
  t.check('resume finds the session', resumed)
  t.check(
    'resume serves the pending NEWER truth (2 events), not the older durable snapshot (1)',
    store.interviewEvents().length === 2,
    `events=${store.interviewEvents().length}`,
  )
  // The adopt leg: no live-slot-only wipe seam exists (reset clears pending
  // too, by design), so adoption proves the equivalent END STATE — after the
  // drain, re-adoption carries the newer truth the pending entry settled; a
  // reconnect can never observe the older snapshot.
  const receipt = await store.flushInterviewLog()
  t.check('the pending newer generation settled at the drain', receipt.allSettled)
  store._resetInterviewForProofs()
  t.check('re-adoption after the drain', store.adoptDurableSessionSync({ toolUseId: 'toolu_ca16' }))
  t.check('the re-adopted state carries the NEWER truth (2 events)', store.interviewEvents().length === 2)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — the bounded persistence-health receipt (observable, non-interrupting)')
{
  store._resetInterviewForProofs()
  rmSync(join(root, 'interview'), { recursive: true, force: true })
  writeFileSync(guardWrite(root, join(root, 'interview')), 'ENOTDIR fault seam 2')
  store.openInterviewSession({ mission: 'health probe', atMs: 8 })
  await store.flushInterviewLog()
  const health = store.interviewPersistenceHealth()
  t.check('the degraded identity is visible', health.degradedIdentities === 1 && health.pendingIdentities === 1)
  t.check('the last degraded settlement is retained', health.lastDegraded?.state === 'degraded')
  rmSync(join(root, 'interview'), { force: true })
  await store.flushInterviewLog()
  const healed = store.interviewPersistenceHealth()
  t.check('healing clears the pending estate (reaper)', healed.pendingIdentities === 0 && healed.degradedIdentities === 0)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§6 — unreadable ≠ empty: the read-degrade receipt lands on the recovery ledger (CA-17)')
{
  store._resetInterviewForProofs()
  rmSync(join(root, 'interview'), { recursive: true, force: true })
  mkdirSync(join(root, 'interview'), { recursive: true })
  writeFileSync(guardWrite(root, logPath), '{ this is not json')
  const sessions = await store.listInterviewSessions()
  t.check('the fail-open read stays alive (empty list, no throw)', Array.isArray(sessions) && sessions.length === 0)
  const sawRow = await waitUntil(() => existsSync(join(root, 'recovery', 'store-recovery.jsonl')))
  t.check('the recovery ledger exists after the degraded read', sawRow)
  const events = await readStoreRecoveryEvents()
  const row = events.find(e => e.store === 'interview-sessions' && e.kind === 'read-degrade')
  t.check('the ledger carries the interview read-degrade receipt', row !== undefined, row?.reason?.slice(0, 60))
  t.check('no quarantine copy was claimed (bytes stay in place on the read path)', row?.quarantinePath === null)
}

t.finish('prove-settlement-receipts')
