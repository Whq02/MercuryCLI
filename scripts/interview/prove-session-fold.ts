#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-session-fold.ts — (and the identity half of
// the interview session fold's laws, pinned for the pool.
//
//    §1  IDEMPOTENT REPLAY — folding every event twice (same eventIds)
//        produces deep-equal state; a duplicate mid-stream is a no-op.
//    §2  LIVE ≡ REBUILD — the incremental fold equals rebuildInterview over
//        the same events, and the fold never mutates its input state.
//    §3  REWORD PRESERVES IDENTITY — re-presenting a known questionId with
//        new display text keeps the committed answer, note, and context
//        association; only the display copy moves.
//    §4  REVISION PRESERVES THE REST — re-committing one decision leaves
//        every other question's state reference-stable, and the superseded
//        value lands in priorCommits (history, not loss).
//    §5  BOUNDED MALFORMED INPUT — events for unknown questions/refs no-op;
//        the fold never throws.
//    §6  SERIALIZATION ROUND-TRIP — JSON round-trip of the event log rebuilds
//        byte-identical state (restart-safe by construction).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'
import {
  emptyInterviewState,
  foldInterview,
  rebuildInterview,
  type InterviewEvent,
} from '../../src/services/interview/contracts.ts'

const t = checker()

let n = 0
const ev = <K extends InterviewEvent['kind']>(
  kind: K,
  fields: Omit<Extract<InterviewEvent, { kind: K }>, 'kind' | 'eventId' | 'atMs'>,
): InterviewEvent =>
  ({ kind, eventId: `e_${++n}`, atMs: 1_700_000_000_000 + n, ...fields }) as InterviewEvent

const Q1 = {
  id: 'q_engine',
  decisionId: 'd_engine',
  text: 'Which storage engine should the cache use?',
  header: 'Cache',
  options: [
    { id: 'opt_redis', label: 'Redis', description: 'shared' },
    { id: 'opt_mem', label: 'In-memory', description: 'local' },
  ],
  multiSelect: false,
}
const Q2 = {
  id: 'q_evict',
  decisionId: 'd_evict',
  text: 'Which eviction policy fits?',
  header: 'Eviction',
  options: [
    { id: 'opt_lru', label: 'LRU', description: 'recency' },
    { id: 'opt_lfu', label: 'LFU', description: 'frequency' },
  ],
  multiSelect: false,
}

const SCRIPT: InterviewEvent[] = [
  ev('session-opened', { sessionId: 'is_1', mission: 'design the cache layer' }),
  ev('questions-presented', { questions: [Q1, Q2], round: 1 }),
  ev('answer-drafted', { questionId: 'q_engine', value: { optionIds: ['opt_redis'] } }),
  ev('answer-committed', { questionId: 'q_engine', value: { optionIds: ['opt_redis'] } }),
  ev('note-set', { questionId: 'q_engine', note: 'ops already runs redis' }),
  ev('context-attached', {
    ref: { refId: 'ref_1', kind: 'file', label: 'cache.ts' },
    questionId: 'q_engine',
  }),
  ev('answer-committed', { questionId: 'q_evict', value: { optionIds: ['opt_lru'] } }),
]

t.section('§1 — idempotent replay')
{
  const once = rebuildInterview(SCRIPT)
  const twice = rebuildInterview([...SCRIPT, ...SCRIPT])
  t.check('double replay is deep-equal to single', JSON.stringify(once) === JSON.stringify(twice))
  const midDup = rebuildInterview([SCRIPT[0]!, SCRIPT[1]!, SCRIPT[1]!, ...SCRIPT.slice(2)])
  t.check('a mid-stream duplicate is a no-op', JSON.stringify(once) === JSON.stringify(midDup))
}

t.section('§2 — live ≡ rebuild, no input mutation')
{
  let live = emptyInterviewState()
  const before = JSON.stringify(live)
  for (const e of SCRIPT) live = foldInterview(live, e)
  t.check('live-incremental equals rebuild', JSON.stringify(live) === JSON.stringify(rebuildInterview(SCRIPT)))
  t.check('the fold never mutated the empty input', JSON.stringify(emptyInterviewState()) === before)
}

t.section('§3 — reword preserves identity')
{
  const reworded = { ...Q1, text: 'Which storage engine should the cache LAYER use?' }
  const s = rebuildInterview([...SCRIPT, ev('questions-presented', { questions: [reworded], round: 2 })])
  const qs = s.questions['q_engine']!
  t.check('display copy moved', qs.question.text.includes('LAYER'))
  t.check('the committed answer survived the reword', qs.committed?.optionIds[0] === 'opt_redis')
  t.check('the note survived the reword', qs.note === 'ops already runs redis')
  t.check('the context association survived', s.contextScope['ref_1'] === 'q_engine')
  t.check('no duplicate question was minted', s.questionOrder.filter(id => id === 'q_engine').length === 1)
  t.check('the round advanced', s.round === 2)
}

t.section('§4 — revision preserves unaffected decisions')
{
  const base = rebuildInterview(SCRIPT)
  const revised = foldInterview(
    base,
    ev('answer-committed', { questionId: 'q_engine', value: { optionIds: ['opt_mem'] } }),
  )
  t.check('the revised decision moved', revised.questions['q_engine']!.committed?.optionIds[0] === 'opt_mem')
  t.check(
    'the superseded value landed in priorCommits',
    revised.questions['q_engine']!.priorCommits.at(-1)?.optionIds[0] === 'opt_redis',
  )
  t.check(
    'the unaffected decision is REFERENCE-stable',
    revised.questions['q_evict'] === base.questions['q_evict'],
  )
}

t.section('§5 — bounded malformed input')
{
  const base = rebuildInterview(SCRIPT)
  const ghosts: InterviewEvent[] = [
    ev('answer-committed', { questionId: 'q_ghost', value: { optionIds: ['x'] } }),
    ev('note-set', { questionId: 'q_ghost', note: 'nope' }),
    ev('context-detached', { refId: 'ref_ghost' }),
    ev('navigated', { target: 'q_ghost' }),
    ev('discussion-returned', { questionId: 'q_engine' }),
  ]
  let s = base
  let threw = false
  try {
    for (const g of ghosts) s = foldInterview(s, g)
  } catch {
    threw = true
  }
  t.check('no ghost event throws', !threw)
  const scrub = (x: typeof s) => JSON.stringify({ ...x, seenEventIds: [] })
  t.check('ghost events change nothing but the receipt log', scrub(s) === scrub(base))
}

t.section('§6 — serialization round-trip')
{
  const wire = JSON.parse(JSON.stringify(SCRIPT)) as InterviewEvent[]
  t.check(
    'the JSON round-tripped log rebuilds identical state',
    JSON.stringify(rebuildInterview(wire)) === JSON.stringify(rebuildInterview(SCRIPT)),
  )
}

t.finish('prove-session-fold')
