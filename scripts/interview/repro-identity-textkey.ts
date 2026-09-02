#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/repro-identity-textkey.ts — expect-red
//  reproducer: interview meaning is keyed by DISPLAYED QUESTION TEXT, so a
//  reworded question orphans the operator's prior input.
//
//  Two live behaviors of the shipped tool contract pin the defect:
//    §1  an operator note captured under the original phrasing VANISHES from
//        the wire result when the model re-issues the question reworded —
//        `annotations?.[questionText]` joins on display copy;
//    §2  the input contract cannot even EXPRESS stable question identity —
//        the strict schema rejects an `id` field, so no adapter can join
//        rounds on anything but text.
//
//  While the Wave A identity contract does not exist this exits 3
//  (CHECKS_FAILED_EXIT — "still reproduces"); scripts/interview/run-all.sh
//  holds it to recorded status.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')

t.section('§1 — a reworded question keeps the operator note on the wire (the PRODUCTION shape)')
{
  // The production surface (the interview workspace) submits id-keyed
  // answers/annotations — the shape the Wave B controller produces. A round-2
  // reword changes only the display text; the id join keeps the note.
  const reworded = 'Which storage engine should the cache layer use?'
  const NOTE = 'prefer the engine ops already runs'
  const result = {
    questions: [
      {
        id: 'iq_engine',
        decisionId: 'id_engine',
        question: reworded,
        header: 'Cache',
        options: [
          { id: 'io_redis', label: 'Redis', description: 'shared' },
          { id: 'io_mem', label: 'In-memory', description: 'local' },
        ],
        multiSelect: false,
      },
    ],
    answers: { iq_engine: 'Redis' },
    annotations: { iq_engine: { notes: NOTE } },
  }
  const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam!(
    result as never,
    'toolu_repro_1',
  )
  const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  t.check(
    'the operator note survives the reword onto the wire',
    content.includes(NOTE),
    'the id join failed — the note vanished',
  )
}

t.section('§2 — the input contract can express stable question identity')
{
  const withIds = {
    questions: [
      {
        id: 'q_cache_engine',
        question: 'Which storage engine should the cache use?',
        header: 'Cache',
        options: [
          { id: 'opt_redis', label: 'Redis', description: 'shared' },
          { label: 'In-memory', description: 'local' },
        ],
        multiSelect: false,
      },
    ],
  }
  const parsed = AskUserQuestionTool.inputSchema.safeParse(withIds)
  // The nested question schema silently STRIPS unknown keys, so admission
  // alone proves nothing — identity must SURVIVE the parse to ride the
  // contract.
  const q = parsed.success
    ? (parsed.data as { questions: Record<string, unknown>[] }).questions[0]
    : undefined
  t.check(
    'a stable question ID survives input parsing',
    parsed.success && q?.id === 'q_cache_engine',
    parsed.success ? 'the schema stripped the id — identity cannot ride the contract' : 'schema rejected the input',
  )
}

t.finish('repro-identity-textkey')
