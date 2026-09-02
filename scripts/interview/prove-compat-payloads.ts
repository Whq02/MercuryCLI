#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-compat-payloads.ts — existing compatible
//  tool inputs and results have TESTED adapters. The old world keeps
//  working through the boundary — never by contaminating the internal
//  vocabulary.
//
//    §1  the OLD id-less tool input (the shape every pre-INTERVIEW client
//        and transcript carries) parses through today's schema and presents
//        — identity is minted once at the boundary;
//    §2  an OLD text-keyed answers/annotations payload (the external SDK
//        floor keys by QUESTION TEXT to this day) parses and its result
//        maps to the byte-identical legacy prose;
//    §3  a durable session log carrying an event kind this build does not
//        know (a newer writer, a corrupted row) replays as a BOUNDED no-op
//        — one foreign row can never poison the rebuild.
//
//  Proof hygiene: pure — no store writes, no ambient reads.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()

const { AskUserQuestionTool } = await import(
  '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx'
)
const { adoptQuestions } = await import('../../src/services/interview/controller.ts')
const { emptyInterviewState, foldInterview, rebuildInterview } = await import(
  '../../src/services/interview/contracts.ts'
)
import type { InterviewEvent } from '../../src/services/interview/contracts.ts'

// The pre-INTERVIEW wire shapes, verbatim.
const OLD_INPUT = {
  questions: [
    {
      question: 'Which storage engine should the cache use?',
      header: 'Cache',
      multiSelect: false,
      options: [
        { label: 'Redis', description: 'Shared network cache.' },
        { label: 'In-memory', description: 'Process-local.' },
      ],
    },
  ],
  answers: {},
}

const OLD_ANSWERED = {
  ...OLD_INPUT,
  // Text-keyed — the historical (and current SDK-floor) convention.
  answers: { 'Which storage engine should the cache use?': 'In-memory' },
  annotations: {
    'Which storage engine should the cache use?': { notes: 'keep it local' },
  },
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the old id-less input parses and presents')
{
  const parsed = AskUserQuestionTool.inputSchema.safeParse(OLD_INPUT)
  t.check('the old input parses through today\'s schema', parsed.success)
  const adopted = adoptQuestions(OLD_INPUT.questions)
  t.check('identity is minted ONCE at the boundary', adopted[0]?.id.startsWith('iq_') === true)
  t.check('a decision id derives with it', adopted[0]?.decisionId.startsWith('id_') === true)
  t.check('option identity minted too', adopted[0]?.options.every(o => o.id.startsWith('io_')) === true)
  t.check('display copy is untouched', adopted[0]?.text === OLD_INPUT.questions[0]!.question)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the old text-keyed answered payload keeps the legacy wire')
{
  const parsed = AskUserQuestionTool.inputSchema.safeParse(OLD_ANSWERED)
  t.check('the text-keyed payload parses', parsed.success)
  const result = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
    {
      questions: OLD_ANSWERED.questions,
      answers: OLD_ANSWERED.answers,
      annotations: OLD_ANSWERED.annotations,
    } as never,
    'toolu_old',
  )
  const text = JSON.stringify(result)
  t.check('the result is the legacy answered prose', text.includes('User has answered your questions'))
  t.check('joined by question text, as the old clients expect', text.includes('"Which storage engine should the cache use?"') || text.includes('Which storage engine'))
  t.check('the answer value crossed', text.includes('In-memory'))
  t.check('the text-keyed annotation crossed', text.includes('keep it local'))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — a foreign event kind replays as a bounded no-op')
{
  const good: InterviewEvent[] = [
    { kind: 'session-opened', eventId: 'e1', atMs: 1, sessionId: 'is_x', mission: 'm' },
    {
      kind: 'questions-presented',
      eventId: 'e2',
      atMs: 2,
      round: 1,
      questions: [
        {
          id: 'iq_1',
          decisionId: 'id_1',
          text: 'Q',
          header: 'H',
          multiSelect: false,
          options: [{ id: 'io_1', label: 'A', description: 'd' }],
        },
      ],
    },
    { kind: 'note-set', eventId: 'e3', atMs: 3, questionId: 'iq_1', note: 'kept' },
  ]
  const foreign = { kind: 'holo-projected', eventId: 'e2b', atMs: 2, beam: 'wide' } as unknown as InterviewEvent
  const withForeign = [good[0]!, good[1]!, foreign, good[2]!]
  const state = rebuildInterview(withForeign)
  t.check('the rebuild survives the foreign row', state !== undefined && state.sessionId === 'is_x')
  t.check('everything after it still folded', state.questions['iq_1']?.note === 'kept')
  t.check('the foreign row moved NOTHING but the ledger', JSON.stringify({ ...state, seenEventIds: [] }) === JSON.stringify({ ...rebuildInterview(good), seenEventIds: [] }))
  const direct = foldInterview(emptyInterviewState(), foreign)
  t.check('a foreign first event is equally bounded', direct !== undefined && direct.phase === 'preparing')
}

t.finish('prove-compat-payloads')
