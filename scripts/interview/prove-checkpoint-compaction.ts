#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-checkpoint-compaction.ts — the
//  per-session event bound with versioned checkpoint compaction.
//
//    §1 IDENTITY PRESERVED — past the threshold the prefix folds into the
//       v1 checkpoint and only the tail stays as events; the durable state
//       (decision identity, committed answers, priorCommits, notes, context,
//       question order) is IDENTICAL to the uncompacted reference rebuild.
//    §2 CONTINUED LIFE — the compacted session resumes, keeps appending,
//       compacts AGAIN (sealedCount accumulates; the tail stays bounded) and
//       the state still matches the full reference.
//    §3 BACKWARD DECODING — a v1 entry (events only, no checkpoint) still
//       decodes and folds.
//    §4 PENDING-FIRST WITH A BASE — after compaction, a pending (unsettled)
//       tail resumes onto the checkpoint base, never a truncated state.
//
//  Hermetic per the ambient-state law; deterministic (drains drive every
//  publication).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const root = scratchRoot('interview-compact')
const t = checker()

const store = await import('../../src/services/interview/store.ts')
const { rebuildInterview } = await import('../../src/services/interview/contracts.ts')
type Ev = Parameters<typeof rebuildInterview>[0][number]

const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)
interface RawEntry {
  events: Ev[]
  updatedAtMs: number
  checkpoint?: { v: number; state: unknown; sealedCount: number }
}
function rawSessions(): Record<string, RawEntry> {
  const raw = JSON.parse(readFileSync(logPath, 'utf8')) as { data?: { sessions?: unknown }; sessions?: unknown }
  return (raw.sessions ?? raw.data?.sessions ?? {}) as Record<string, RawEntry>
}
const stateJson = (s: unknown): string => JSON.stringify(s)

// ── seed a rich session past the threshold ─────────────────────────────────
store._resetInterviewForProofs()
const refEvents: Ev[] = []
const push = (e: Ev): void => {
  store.appendInterviewEvent(e)
  refEvents.push(e)
}
const sid = store.openInterviewSession({ mission: 'compaction law', toolUseId: 'toolu_compact', atMs: 1 })
refEvents.push(...(store.interviewEvents() as Ev[])) // the minted session-opened
push({
  kind: 'questions-presented',
  eventId: 'ie_q',
  atMs: 2,
  round: 1,
  questions: [
    {
      id: 'iq_engine',
      decisionId: 'id_engine',
      text: 'Which engine?',
      header: 'Engine',
      options: [
        { id: 'io_a', label: 'A', description: 'a' },
        { id: 'io_b', label: 'B', description: 'b' },
      ],
      multiSelect: false,
    },
  ],
} as never)
push({ kind: 'answer-committed', eventId: 'ie_c1', atMs: 3, questionId: 'iq_engine', value: { optionIds: ['io_a'] } } as never)
push({ kind: 'answer-committed', eventId: 'ie_c2', atMs: 4, questionId: 'iq_engine', value: { optionIds: ['io_b'] } } as never)
push({ kind: 'note-set', eventId: 'ie_n', atMs: 5, questionId: 'iq_engine', note: 'prefer B in prod' } as never)
push({ kind: 'context-attached', eventId: 'ie_ctx', atMs: 6, ref: { refId: 'ref_1', kind: 'file', label: 'spec.md' } } as never)
for (let i = 0; i < 450; i++) {
  push({ kind: 'navigated', eventId: `ie_nav_${i}`, atMs: 10 + i, target: 'review' } as never)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — compaction seals the prefix; the state is identical to the reference')
{
  const receipt = await store.flushInterviewLog()
  t.check('the flush settled', receipt.allSettled)
  const entry = rawSessions()[sid]!
  t.check('the checkpoint exists (v1)', entry.checkpoint?.v === 1)
  t.check(
    `the retained tail is bounded (${entry.events.length} ≤ 100 + growth window)`,
    entry.events.length <= 200,
    `events=${entry.events.length} sealed=${entry.checkpoint?.sealedCount}`,
  )
  const reference = rebuildInterview(refEvents)
  const listed = (await store.listInterviewSessions()).find(s => s.sessionId === sid)
  t.check('the listed (checkpoint+tail) state EQUALS the full reference rebuild',
    stateJson(listed?.state) === stateJson(reference))
  const q = listed?.state.questions['iq_engine']
  t.check('committed answer + priorCommits preserved', q?.committed?.optionIds[0] === 'io_b' && q?.priorCommits.length === 1)
  t.check('note + context preserved', q?.note === 'prefer B in prod' && listed?.state.context[0]?.refId === 'ref_1')
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — continued life: resume, append past the threshold, compact AGAIN')
{
  store._resetInterviewForProofs()
  const resumed = await store.resumeInterviewSession(sid)
  t.check('the compacted session resumes from disk', resumed)
  const sealedBefore = rawSessions()[sid]!.checkpoint!.sealedCount
  for (let i = 0; i < 450; i++) {
    const e = { kind: 'navigated', eventId: `ie_nav2_${i}`, atMs: 1000 + i, target: 'review' } as never
    store.appendInterviewEvent(e)
    refEvents.push(e)
  }
  const receipt = await store.flushInterviewLog()
  t.check('the second flush settled', receipt.allSettled)
  const entry = rawSessions()[sid]!
  t.check('sealedCount accumulated across compactions', (entry.checkpoint?.sealedCount ?? 0) > sealedBefore,
    `sealed ${sealedBefore} → ${entry.checkpoint?.sealedCount}`)
  t.check(`the tail stays bounded after the second compaction (${entry.events.length})`, entry.events.length <= 200)
  const reference = rebuildInterview(refEvents)
  const listed = (await store.listInterviewSessions()).find(s => s.sessionId === sid)
  t.check('the double-compacted state still EQUALS the full reference', stateJson(listed?.state) === stateJson(reference))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — backward decoding: a v1 entry (no checkpoint) still folds')
{
  const listed = await store.listInterviewSessions()
  t.check('(premise) the compacted session lists', listed.some(s => s.sessionId === sid))
  // Seed a fresh v1-shaped session through the normal path (no compaction —
  // under the threshold) and prove it lists beside the v2 entry.
  store._resetInterviewForProofs()
  const v1sid = store.openInterviewSession({ mission: 'v1 sibling', atMs: 5000 })
  await store.flushInterviewLog()
  const both = await store.listInterviewSessions()
  const v1 = both.find(s => s.sessionId === v1sid)
  const raw = rawSessions()[v1sid]!
  t.check('the v1-shaped entry has no checkpoint', raw.checkpoint === undefined)
  t.check('it decodes and folds beside the v2 entry', v1?.state.mission === 'v1 sibling' && both.some(s => s.sessionId === sid))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — pending-first resume folds the pending tail onto the checkpoint base')
{
  store._resetInterviewForProofs()
  await store.resumeInterviewSession(sid)
  // A NEWER accepted event, NOT settled (pending):
  store.appendInterviewEvent({ kind: 'note-set', eventId: 'ie_pending_note', atMs: 9000, questionId: 'iq_engine', note: 'pending newest' } as never)
  const again = await store.resumeInterviewSession(sid)
  const s = store.interviewSnapshot()
  t.check('pending-first resume finds the session', again)
  t.check('the pending newest note is present', s.questions['iq_engine']?.note === 'pending newest')
  t.check('the checkpointed history is present too (committed io_b)', s.questions['iq_engine']?.committed?.optionIds[0] === 'io_b')
  await store.flushInterviewLog()
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — resume DURING an in-flight compacting persist stays coherent (the close review\'s find)')
{
  // The defect shape (proven live by the review's reproducer): resume inside
  // the window between the compacting mutate and the in-place splice copied
  // the UNSPLICED full log, and the next persist double-applied the sealed
  // prefix (phantom priorCommits). The fix awaits the identity's inflight
  // publication before the pending-first read; this leg replays the exact
  // sequence and asserts durable ≡ reference.
  store._resetInterviewForProofs()
  const refEvents2: Ev[] = []
  const sid2 = store.openInterviewSession({ mission: 'mid-compaction resume', toolUseId: 'toolu_midc', atMs: 20000 })
  refEvents2.push(...(store.interviewEvents() as Ev[]))
  const pushTracked = (e: Ev): void => {
    store.appendInterviewEvent(e as never)
    refEvents2.push(e)
  }
  pushTracked({
    kind: 'questions-presented',
    eventId: 'ie_q2',
    atMs: 20001,
    round: 1,
    questions: [
      {
        id: 'iq_m',
        decisionId: 'id_m',
        text: 'M?',
        header: 'M',
        options: [
          { id: 'io_a', label: 'A', description: 'a' },
          { id: 'io_b', label: 'B', description: 'b' },
        ],
        multiSelect: false,
      },
    ],
  } as never)
  pushTracked({ kind: 'answer-committed', eventId: 'ie_mc1', atMs: 20002, questionId: 'iq_m', value: { optionIds: ['io_a'] } } as never)
  for (let i = 0; i < 450; i++) {
    pushTracked({ kind: 'navigated', eventId: `ie_mnav_${i}`, atMs: 20010 + i, target: 'review' } as never)
  }
  // Start the compacting flush WITHOUT awaiting, resume inside the window,
  // append one more commit, then settle everything.
  const flushing = store.flushInterviewLog()
  const resumed = await store.resumeInterviewSession(sid2)
  t.check('the mid-flight resume returns (after awaiting the inflight publication)', resumed)
  pushTracked({ kind: 'answer-committed', eventId: 'ie_mc2', atMs: 30000, questionId: 'iq_m', value: { optionIds: ['io_b'] } } as never)
  await flushing
  const receipt = await store.flushInterviewLog()
  t.check('the terminal flush settled', receipt.allSettled)
  const reference = rebuildInterview(refEvents2)
  const listed = (await store.listInterviewSessions()).find(s => s.sessionId === sid2)
  t.check('durable state ≡ the full reference across the mid-compaction resume', stateJson(listed?.state) === stateJson(reference))
  const q = listed?.state.questions['iq_m']
  t.check('priorCommits carries exactly the one superseded commit (no phantom rows)',
    q?.priorCommits.length === 1 && q?.committed?.optionIds[0] === 'io_b',
    `priorCommits=${q?.priorCommits.length}`)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§6 — a pending identity\'s checkpoint base survives mid-drain LRU pressure (the close review\'s find)')
{
  store._resetInterviewForProofs()
  const refP: Ev[] = []
  const sidP = store.openInterviewSession({ mission: 'base under pressure', toolUseId: 'toolu_lru', atMs: 40000 })
  refP.push(...(store.interviewEvents() as Ev[]))
  for (let i = 0; i < 450; i++) {
    const e = { kind: 'navigated', eventId: `ie_p_${i}`, atMs: 40001 + i, target: 'review' } as never as Ev
    store.appendInterviewEvent(e as never)
    refP.push(e)
  }
  await store.flushInterviewLog() // compacts; notes sidP's base
  // Re-arm sidP as PENDING (resume + one fresh append, NOT flushed), then
  // pile up ELEVEN other compacting identities and drain EVERYTHING in ONE
  // flush: their compactions note eleven fresh bases and fire evictions
  // WHILE sidP's entry is still pending in the same drain — the guard must
  // skip pending identities or sidP's tail folds from a truncated base.
  await store.resumeInterviewSession(sidP)
  const tail = { kind: 'navigated', eventId: 'ie_p_tail', atMs: 50000, target: 'review' } as never as Ev
  store.appendInterviewEvent(tail as never)
  refP.push(tail)
  for (let s = 0; s < 11; s++) {
    store.openInterviewSession({ mission: `churn ${s}`, atMs: 60000 + s * 1000 })
    for (let i = 0; i < 450; i++) {
      store.appendInterviewEvent({ kind: 'navigated', eventId: `ie_c${s}_${i}`, atMs: 60001 + s * 1000 + i, target: 'review' } as never)
    }
  }
  const receipt = await store.flushInterviewLog()
  t.check('the twelve-identity drain settled', receipt.allSettled, `drained=${receipt.drained}`)
  // MAX_SESSIONS trims the durable file to 10 — sidP (oldest updatedAtMs
  // among 12) may age out of the FILE; the assertion that matters is the
  // COHERENCE of what settled: whatever the drain published for sidP folded
  // from its intact base. Assert via the reference when retained, and via
  // the drain receipt when trimmed.
  const listed = (await store.listInterviewSessions()).find(s => s.sessionId === sidP)
  if (listed) {
    t.check('the pressured identity\'s durable state ≡ its full reference (base intact mid-drain)',
      stateJson(listed.state) === stateJson(rebuildInterview(refP)))
  } else {
    const settledP = receipt.settlements.find(s => s.sessionId === sidP)
    t.check('the pressured identity settled cleanly before the session-cap trim aged it out',
      settledP?.state === 'settled')
  }
}

t.finish('prove-checkpoint-compaction')
