#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-tool-contract-a3.ts — the A3 tool boundary: stable
//  identity and typed outcomes RIDE the contract while every pre-A3 client
//  shape stays byte-identical.
//
//    §1  IDS SURVIVE — question id / decisionId / option id parse AND survive
//        input parsing (nothing strips identity).
//    §2  COMPAT BYTE-IDENTITY — an id-less, outcome-less result (every pre-A3
//        client) produces the EXACT historical wire prose.
//    §3  IDENTITY WIRE SHAPE — with ids present, answers/notes join on the id
//        key and labels are JSON-quoted (reworded questions keep their
//        operator note on the wire — the repro-identity §1 defect, dead on
//        the NEW shape).
//    §4  TYPED OUTCOMES — output parsing preserves `outcome`; discussion /
//        finish / cancel produce honest wire text that names itself and
//        never masquerades as a submission.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')

const wire = (result: unknown): string => {
  const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam!(result as never, 'toolu_a3')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

t.section('§1 — identity survives input parsing')
{
  const parsed = AskUserQuestionTool.inputSchema.safeParse({
    questions: [
      {
        id: 'iq_engine',
        decisionId: 'id_engine',
        question: 'Which engine?',
        header: 'Engine',
        options: [
          { id: 'io_redis', label: 'Redis', description: 'shared' },
          { label: 'In-memory', description: 'local' },
        ],
        multiSelect: false,
      },
    ],
  })
  t.check('the id-carrying input parses', parsed.success)
  const q = parsed.success ? (parsed.data as { questions: Record<string, unknown>[] }).questions[0]! : {}
  t.check('question id survives', q.id === 'iq_engine')
  t.check('decisionId survives', q.decisionId === 'id_engine')
  t.check(
    'option id survives',
    Array.isArray(q.options) && (q.options[0] as Record<string, unknown>).id === 'io_redis',
  )
}

t.section('§2 — the pre-A3 client shape keeps the byte-identical wire')
{
  const legacy = {
    questions: [
      {
        question: 'Which engine?',
        header: 'Engine',
        options: [
          { label: 'Redis', description: 'shared' },
          { label: 'In-memory', description: 'local' },
        ],
        multiSelect: false,
      },
    ],
    answers: { 'Which engine?': 'Redis' },
    annotations: { 'Which engine?': { notes: 'ops runs redis' } },
  }
  t.check(
    'the historical prose is byte-identical',
    wire(legacy) ===
      'User has answered your questions: "Which engine?"="Redis" user notes: ops runs redis. You can now continue with the user\'s answers in mind.',
    wire(legacy).slice(0, 140),
  )
}

t.section('§3 — the identity shape joins on ids and quotes labels')
{
  const NOTE = 'prefer the engine ops already runs'
  const modern = {
    questions: [
      {
        id: 'iq_engine',
        decisionId: 'id_engine',
        question: 'Which storage engine should the cache LAYER use?', // reworded
        header: 'Engine',
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
  const content = wire(modern)
  t.check('the answer joins on the stable id', content.includes('[iq_engine]') && content.includes('"Redis"'))
  t.check('the reworded question keeps the operator note on the wire', content.includes(NOTE))
  const ambiguousA = wire({ ...modern, answers: { iq_engine: '"a, b", "c"' }, annotations: undefined })
  const ambiguousB = wire({ ...modern, answers: { iq_engine: '"a", "b", "c"' }, annotations: undefined })
  t.check('distinct quoted selections stay distinguishable', ambiguousA !== ambiguousB)
}

t.section('§4 — typed outcomes are honest on the wire')
{
  const base = {
    questions: [
      {
        id: 'iq_engine',
        question: 'Which engine?',
        header: 'Engine',
        options: [
          { id: 'io_redis', label: 'Redis', description: 'shared' },
          { id: 'io_mem', label: 'In-memory', description: 'local' },
        ],
        multiSelect: false,
      },
    ],
    answers: {},
  }
  const parsedOut = AskUserQuestionTool.outputSchema.parse({
    ...base,
    outcome: { kind: 'discussion-requested', questionId: 'iq_engine' },
  } as never) as Record<string, unknown>
  t.check('output parsing preserves the outcome', (parsedOut.outcome as { kind?: string })?.kind === 'discussion-requested')

  const discuss = wire({ ...base, outcome: { kind: 'discussion-requested', questionId: 'iq_engine' } })
  t.check('discussion names itself', discuss.includes('DISCUSS') && discuss.includes('Which engine?'))
  t.check('discussion promises the preserved session', discuss.includes('resume at this question'))
  t.check('discussion is not a fake submission', !discuss.includes('User has answered your questions'))

  const finish = wire({ ...base, answers: { iq_engine: 'Redis' }, outcome: { kind: 'finish-requested', retainedDecisionIds: [] } })
  t.check('finish says stop asking', finish.includes('finished the interview early') && finish.includes('Stop asking'))
  t.check('finish carries the answers so far', finish.includes('"Redis"'))

  const cancel = wire({ ...base, outcome: { kind: 'cancelled', preserveDraft: true } })
  t.check('cancel names itself + draft preservation', cancel.includes('cancelled the interview') && cancel.includes('drafts preserved'))
}

t.finish('prove-tool-contract-a3')
