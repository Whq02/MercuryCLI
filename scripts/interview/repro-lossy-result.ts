#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')

const QUESTION = 'Which features should the cache expose?'
const mkResult = (answer: string) => ({
  questions: [
    {
      question: QUESTION,
      header: 'Features',
      options: [
        { label: 'a, b', description: 'the combined toggle' },
        { label: 'a', description: 'first alone' },
        { label: 'b', description: 'second alone' },
        { label: 'c', description: 'third' },
      ],
      multiSelect: true,
    },
  ],
  answers: { [QUESTION]: answer },
})

t.section('§1 — distinct selections stay distinguishable on the wire (the PRODUCTION shape)')
{
  const { encodeAnswerValue } = await import('../../src/services/interview/controller.ts')
  const q = {
    id: 'iq_features',
    decisionId: 'id_features',
    text: QUESTION,
    header: 'Features',
    multiSelect: true,
    options: [
      { id: 'io_ab', label: 'a, b', description: 'combined' },
      { id: 'io_a', label: 'a', description: 'first' },
      { id: 'io_b', label: 'b', description: 'second' },
      { id: 'io_c', label: 'c', description: 'third' },
    ],
  }
  const encode = (optionIds: string[]) => encodeAnswerValue({ optionIds }, q)
  const wire = (answer: string): string => {
    const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam!(
      { ...mkResult(answer), questions: [{ ...mkResult(answer).questions[0], id: q.id }] } as never,
      'toolu_repro_2',
    )
    return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  }
  t.check(
    "selecting ['a, b','c'] and ['a','b','c'] differ on the wire",
    wire(encode(['io_ab', 'io_c'])) !== wire(encode(['io_a', 'io_b', 'io_c'])),
    'byte-identical prose — the selection sets collided',
  )
}

t.section('§2 — the output contract carries a typed outcome')
{
  const parsed = AskUserQuestionTool.outputSchema.parse({
    questions: mkResult('a').questions,
    answers: { [QUESTION]: 'a' },
    outcome: { kind: 'discussion-requested', questionId: 'q_features' },
  } as never) as Record<string, unknown>
  t.check(
    'an outcome field survives output parsing',
    'outcome' in parsed,
    'the schema strips it — submit/discuss/finish/cancel are indistinguishable downstream',
  )
}

t.section('§3 — the decision record is consumed by planning (the IN-14 gap)')
{
  const { existsSync } = await import('node:fs')
  t.check(
    'a planning consumer of the decision record exists',
    existsSync('src/services/interview/decisionRecord.ts'),
    'no production module consumes the record yet — planning still reads prose',
  )
}

t.finish('repro-lossy-result')
