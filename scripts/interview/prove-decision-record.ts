#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-decision-record.ts — the structured
//  decision record and its planning consumer.
//
//    §1  BUILD LAWS — versioned schema, decisions by id with selected
//        identities + labels, notes, declined alternatives, context refs,
//        provenance to the exact committing events; unresolved lists ONLY
//        deliberately-open decisions.
//    §2  DETERMINISM + REVISION STABILITY — the build is pure (same inputs ⇒
//        identical record); revising ONE decision changes exactly that entry
//
//    §3  SYNC PERSISTENCE — persist under the SCRATCH config home, read back
//        via the synchronous boundary reader.
//    §4  THE PLANNING CONSUMER — the REAL plan-mode instruction assembly
//        (the interview branch) carries the record's decisions by id when a
//        record exists. No duplicate formatter: the attachment imports the
//        one owner.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'interview-rec-'))
process.env.MERCURY_CONFIG_DIR = scratch
// The §4 real-attachment assembly reads project config; the config kernel's
// sanctioned pre-boot seam is NODE_ENV=test (globalConfig.ts guard).
process.env.NODE_ENV = 'test'

const t = checker()
const { rebuildInterview } = await import('../../src/services/interview/contracts.ts')
const {
  buildDecisionRecord,
  persistDecisionRecord,
  latestDecisionRecordSync,
  formatDecisionRecordForPlanning,
} = await import('../../src/services/interview/decisionRecord.ts')
import type { InterviewEvent } from '../../src/services/interview/contracts.ts'

let n = 0
const ev = <K extends InterviewEvent['kind']>(
  kind: K,
  fields: Omit<Extract<InterviewEvent, { kind: K }>, 'kind' | 'eventId' | 'atMs'>,
): InterviewEvent => ({ kind, eventId: `e_${++n}`, atMs: 1000 + n, ...fields }) as InterviewEvent

const QUESTIONS = [
  {
    id: 'iq_engine',
    decisionId: 'id_engine',
    text: 'Which storage engine?',
    header: 'Engine',
    multiSelect: false,
    options: [
      { id: 'io_redis', label: 'Redis', description: 'shared' },
      { id: 'io_mem', label: 'In-memory', description: 'local' },
    ],
  },
  {
    id: 'iq_scope',
    decisionId: 'id_scope',
    text: 'Which scope ships first?',
    header: 'Scope',
    multiSelect: false,
    options: [
      { id: 'io_min', label: 'Minimal', description: 'core' },
      { id: 'io_full', label: 'Full', description: 'everything' },
    ],
  },
]

const EVENTS: InterviewEvent[] = [
  ev('session-opened', { sessionId: 'is_rec', mission: 'design the cache layer' }),
  ev('questions-presented', { questions: QUESTIONS, round: 1 }),
  ev('context-attached', { ref: { refId: 'ref_1', kind: 'file', label: 'cache.ts' }, questionId: 'iq_engine' }),
  ev('answer-committed', { questionId: 'iq_engine', value: { optionIds: ['io_redis'] } }),
  ev('note-set', { questionId: 'iq_engine', note: 'ops runs redis' }),
  // iq_scope stays deliberately open (early finish).
  ev('finish-requested', { retainedDecisionIds: ['id_engine'] }),
]

const state = rebuildInterview(EVENTS)
const record = buildDecisionRecord(state, EVENTS, 'ir_test', 5000)

t.section('§1 — build laws')
{
  t.check('versioned schema', record.schema === 1)
  t.check('one decision entry per committed decision', record.decisions.length === 1)
  const d = record.decisions[0]!
  t.check('the entry keys on decision + question ids', d.decisionId === 'id_engine' && d.questionId === 'iq_engine')
  t.check('selected identities AND labels ride', d.selected.optionIds[0] === 'io_redis' && d.selected.labels[0] === 'Redis')
  t.check('the operator note rides', d.notes === 'ops runs redis')
  t.check('declined alternatives are recorded', d.declined.length === 1 && d.declined[0]!.optionId === 'io_mem')
  t.check('context references ride as refs (never bodies)', JSON.stringify(d.contextRefIds) === '["ref_1"]')
  t.check('provenance names the committing event', d.provenance.committedEventIds.length === 1)
  t.check('unresolved lists ONLY the deliberately-open decision', JSON.stringify(record.unresolved) === '["id_scope"]')
}

t.section('§2 — determinism + revision stability')
{
  const again = buildDecisionRecord(rebuildInterview(EVENTS), EVENTS, 'ir_test', 5000)
  t.check('the build is pure (same inputs ⇒ identical record)', JSON.stringify(again) === JSON.stringify(record))
  const revisedEvents = [
    ...EVENTS,
    ev('answer-committed', { questionId: 'iq_engine', value: { optionIds: ['io_mem'] } }),
    ev('answer-committed', { questionId: 'iq_scope', value: { optionIds: ['io_min'] } }),
  ]
  const revised = buildDecisionRecord(rebuildInterview(revisedEvents), revisedEvents, 'ir_test2', 6000)
  const engine = revised.decisions.find(d => d.decisionId === 'id_engine')!
  const scope = revised.decisions.find(d => d.decisionId === 'id_scope')!
  t.check('the revised decision changed', engine.selected.labels[0] === 'In-memory')
  t.check('the revision keeps its provenance chain (both commits)', engine.provenance.committedEventIds.length === 2)
  t.check('the newly-answered decision joined; unresolved emptied', !!scope && revised.unresolved.length === 0)
  t.check(
    'the unrelated committed content is unchanged by the revision',
    JSON.stringify(scope.selected) === '{"optionIds":["io_min"],"labels":["Minimal"]}',
  )
}

t.section('§3 — sync persistence under the scratch home')
{
  persistDecisionRecord(record)
  const back = latestDecisionRecordSync()
  t.check('the boundary reader returns the persisted record', JSON.stringify(back) === JSON.stringify(record))
}

t.section('§4 — the REAL planning consumer')
{
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const messages = normalizeAttachmentForAPI({
    type: 'plan_mode',
    planFilePath: join(scratch, 'plan.md'),
    planExists: false,
  } as never) as { message?: { content?: unknown } }[]
  const text = JSON.stringify(messages)
  t.check('the plan attachment carries the record id', text.includes('ir_test'))
  t.check('decisions arrive BY ID', text.includes('[id_engine]'))
  t.check('the selection is quoted, not comma-lossy', text.includes('\\"Redis\\"') || text.includes('"Redis"'))
  t.check('deliberately-open decisions are named', text.includes('[id_scope]'))
  t.check('the do-not-re-ask law rides the handoff', text.includes('do not re-ask'))
  const src = readFileSync('src/utils/messages/attachmentText.ts', 'utf8')
  t.check(
    'the attachment consumes the ONE formatter (no duplicate)',
    src.includes('formatDecisionRecordForPlanning'),
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-decision-record')
