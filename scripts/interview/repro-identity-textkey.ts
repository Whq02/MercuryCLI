#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')

t.section('§1 — a reworded question keeps the operator note on the wire (the PRODUCTION shape)')
{
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
