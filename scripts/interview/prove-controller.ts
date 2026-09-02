#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-controller.ts — the UI-free controller drives the
//  authority and speaks the boundary adapter honestly (the A3 lifecycle,
//  proven end-to-end without a renderer).
//
//    §1  IDENTITY ADOPTION — declared ids adopted verbatim; absent ids minted
//        once; round 2 with the SAME declared id upserts (no duplicate).
//    §2  SUBMIT — onAllow carries id-keyed answers (multi-select JSON-quoted),
//        id-keyed annotations, the identity-carrying questions, and the typed
//        answers-submitted outcome; the store lands 'completed'.
//    §3  DISCUSS — onAllow carries discussion-requested for the exact
//        question; the store phase is 'discussing'.
//    §4  FINISH — retained decision ids = the committed ones only.
//    §5  CANCEL — the boundary sees the historical bare reject; the store
//        carries the typed cancelled outcome with preserved drafts.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'interview-ctl-'))
process.env.MERCURY_CONFIG_DIR = scratch

const t = checker()
const store = await import('../../src/services/interview/store.ts')
const ctl = await import('../../src/services/interview/controller.ts')

interface BoundaryLog {
  allows: Record<string, unknown>[]
  rejects: number
}
const mkBoundary = (): BoundaryLog & { onAllow: (u: Record<string, unknown>) => void; onReject: () => void } => {
  const log: BoundaryLog = { allows: [], rejects: 0 }
  return Object.assign(log, {
    onAllow: (u: Record<string, unknown>) => void log.allows.push(u),
    onReject: () => void log.rejects++,
  })
}

const INPUT = {
  questions: [
    {
      id: 'iq_engine',
      decisionId: 'id_engine',
      question: 'Which storage engine should the cache use?',
      header: 'Cache',
      options: [
        { id: 'io_redis', label: 'Redis', description: 'shared' },
        { label: 'In-memory', description: 'local' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which features should ship?',
      header: 'Features',
      options: [
        { label: 'TTL, expiry', description: 'time-based' },
        { label: 'Flush', description: 'manual' },
      ],
      multiSelect: true,
    },
  ] as never[],
}

try {
  t.section('§1 — identity adoption + round continuity')
  {
    store._resetInterviewForProofs()
    const { questions } = ctl.presentToolCall({ input: INPUT as never, toolUseId: 'toolu_1' })
    t.check('a declared question id is adopted verbatim', questions[0]!.id === 'iq_engine')
    t.check('a declared decisionId is adopted', questions[0]!.decisionId === 'id_engine')
    t.check('a declared option id is adopted', questions[0]!.options[0]!.id === 'io_redis')
    t.check('an absent question id is minted', questions[1]!.id.startsWith('iq_'))
    t.check('an absent option id is minted', questions[1]!.options[0]!.id.startsWith('io_'))
    const round2 = ctl.presentToolCall({
      input: { questions: [INPUT.questions[0]] } as never,
      toolUseId: 'toolu_2',
    })
    const s = store.interviewSnapshot()
    t.check('round 2 joined the SAME session', round2.sessionId === s.sessionId && s.round === 2)
    t.check('the re-declared id upserted (no duplicate)', s.questionOrder.filter(q => q === 'iq_engine').length === 1)
  }

  t.section('§2 — submit through the boundary')
  {
    const s0 = store.interviewSnapshot()
    const featuresId = s0.questionOrder.find(q => q !== 'iq_engine')!
    const features = s0.questions[featuresId]!.question
    ctl.commitAnswer('iq_engine', { optionIds: ['io_redis'] })
    ctl.setNote('iq_engine', 'ops already runs redis')
    ctl.commitAnswer(featuresId, { optionIds: features.options.map(o => o.id) })
    const boundary = mkBoundary()
    ctl.submitInterview(boundary, INPUT as never)
    t.check('exactly one allow crossed the boundary', boundary.allows.length === 1 && boundary.rejects === 0)
    const u = boundary.allows[0] as {
      answers?: Record<string, string>
      annotations?: Record<string, { notes?: string }>
      outcome?: { kind?: string; decisionRecordId?: string }
      questions?: { id?: string }[]
    }
    t.check('answers key on stable ids', u.answers?.['iq_engine'] === 'Redis')
    t.check(
      'multi-select labels are JSON-quoted (collision-proof)',
      u.answers?.[featuresId] === '"TTL, expiry", "Flush"',
      u.answers?.[featuresId],
    )
    t.check('annotations key on stable ids', u.annotations?.['iq_engine']?.notes === 'ops already runs redis')
    t.check('the updated questions carry identity', u.questions?.every(q => typeof q.id === 'string') === true)
    t.check('the typed outcome rides the allow', u.outcome?.kind === 'answers-submitted' && !!u.outcome?.decisionRecordId)
    t.check('the store landed completed', store.interviewSnapshot().phase === 'completed')
  }

  t.section('§3 — discuss through the boundary')
  {
    store._resetInterviewForProofs()
    ctl.presentToolCall({ input: INPUT as never })
    ctl.draftAnswer('iq_engine', { optionIds: ['io_redis'] })
    const boundary = mkBoundary()
    ctl.requestDiscussion(boundary, INPUT as never, 'iq_engine')
    const u = boundary.allows[0] as { outcome?: { kind?: string; questionId?: string } }
    t.check('discussion-requested crossed with the exact question', u?.outcome?.kind === 'discussion-requested' && u?.outcome?.questionId === 'iq_engine')
    t.check('the store phase is discussing', store.interviewSnapshot().phase === 'discussing')
    t.check('the draft survives into the session', store.interviewSnapshot().questions['iq_engine']?.draft?.optionIds[0] === 'io_redis')
  }

  t.section('§4 — finish retains only committed decisions')
  {
    store._resetInterviewForProofs()
    ctl.presentToolCall({ input: INPUT as never })
    ctl.commitAnswer('iq_engine', { optionIds: ['io_redis'] })
    const boundary = mkBoundary()
    ctl.requestFinish(boundary, INPUT as never)
    const u = boundary.allows[0] as { outcome?: { kind?: string; retainedDecisionIds?: string[] } }
    t.check(
      'retained ids = the committed decision only',
      u?.outcome?.kind === 'finish-requested' && JSON.stringify(u?.outcome?.retainedDecisionIds) === '["id_engine"]',
      JSON.stringify(u?.outcome?.retainedDecisionIds),
    )
  }

  t.section('§5 — cancel stays the historical bare reject')
  {
    store._resetInterviewForProofs()
    ctl.presentToolCall({ input: INPUT as never })
    ctl.draftAnswer('iq_engine', { optionIds: ['io_redis'] })
    const boundary = mkBoundary()
    ctl.cancelInterview(boundary)
    t.check('the boundary saw one bare reject, zero allows', boundary.rejects === 1 && boundary.allows.length === 0)
    const s = store.interviewSnapshot()
    t.check('the store carries the typed cancelled outcome', s.outcome?.kind === 'cancelled')
    t.check('drafts are preserved', s.outcome?.kind === 'cancelled' && s.outcome.preserveDraft === true)
  }
} finally {
  store._resetInterviewForProofs()
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('prove-controller')
