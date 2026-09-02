#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-discuss-return.ts — mechanics: the
//  discuss-and-return round-trip preserves draft, note, context, focus, and
//  identity through the ONE session authority.
//
//    §1  DISCUSS OUT — requestDiscussion crosses the boundary typed and
//        parks the session in 'discussing' with the draft intact.
//    §2  RETURN — the model's next presentation (same declared ids) folds
//        the typed return: same session, phase back to 'asking', focus ON
//        the discussed question, draft/note/context untouched, no duplicate
//        question minted.
//    §3  NO SILENT ANSWER — the return leaves the committed state exactly
//        as it was; a discussion proposal only ever lands as a fresh DRAFT.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'interview-dr-'))
process.env.MERCURY_CONFIG_DIR = scratch

const t = checker()
const store = await import('../../src/services/interview/store.ts')
const ctl = await import('../../src/services/interview/controller.ts')

const INPUT = {
  questions: [
    {
      id: 'iq_engine',
      decisionId: 'id_engine',
      question: 'Which storage engine should the cache use?',
      header: 'Cache',
      options: [
        { id: 'io_redis', label: 'Redis', description: 'shared' },
        { id: 'io_mem', label: 'In-memory', description: 'local' },
      ],
      multiSelect: false,
    },
  ] as never[],
}

try {
  t.section('§1 — discuss out')
  {
    store._resetInterviewForProofs()
    ctl.presentToolCall({ input: INPUT as never })
    ctl.draftAnswer('iq_engine', { optionIds: ['io_redis'], freeText: 'leaning shared' })
    ctl.setNote('iq_engine', 'ask about the ops budget')
    store.appendInterviewEvent({
      kind: 'context-attached',
      eventId: 'ie_ctx',
      atMs: 1,
      ref: { refId: 'ref_cache', kind: 'file', label: 'cache.ts' },
      questionId: 'iq_engine',
    })
    let allows = 0
    ctl.requestDiscussion(
      { onAllow: () => void allows++, onReject: () => {} },
      INPUT as never,
      'iq_engine',
    )
    const s = store.interviewSnapshot()
    t.check('the typed outcome crossed the boundary', allows === 1)
    t.check('the session parked in discussing', s.phase === 'discussing' && s.discussing === 'iq_engine')
    t.check('the draft survived the exit', s.questions['iq_engine']?.draft?.freeText === 'leaning shared')
  }

  t.section('§2 — the return')
  {
    const before = store.interviewSnapshot()
    const reworded = {
      questions: [
        { ...(INPUT.questions[0] as Record<string, unknown>), question: 'Which storage engine — given the ops budget?' },
      ],
    }
    const { sessionId } = ctl.presentToolCall({ input: reworded as never })
    const s = store.interviewSnapshot()
    t.check('the SAME session continued', sessionId === before.sessionId)
    t.check('phase returned to asking', s.phase === 'asking' && s.discussing === null)
    t.check('focus landed on the discussed question', s.focus === 'iq_engine')
    t.check('the reworded text arrived under the SAME identity', s.questions['iq_engine']?.question.text.includes('ops budget') === true)
    t.check('no duplicate question was minted', s.questionOrder.filter(q => q === 'iq_engine').length === 1)
    t.check('the draft survived the round-trip', s.questions['iq_engine']?.draft?.freeText === 'leaning shared')
    t.check('the note survived', s.questions['iq_engine']?.note === 'ask about the ops budget')
    t.check('the context association survived', s.contextScope['ref_cache'] === 'iq_engine')
  }

  t.section('§3 — no silent answer')
  {
    const s = store.interviewSnapshot()
    t.check('nothing committed during the round-trip', s.questions['iq_engine']?.committed === undefined)
    ctl.commitAnswer('iq_engine', { optionIds: ['io_mem'] })
    t.check(
      'the operator (not the discussion) decides',
      store.interviewSnapshot().questions['iq_engine']?.committed?.optionIds[0] === 'io_mem',
    )
  }
} finally {
  store._resetInterviewForProofs()
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('prove-discuss-return')
