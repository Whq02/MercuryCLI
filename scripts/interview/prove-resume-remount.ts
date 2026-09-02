#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-resume-remount.ts — at the owners: partial
//  interview MEANING survives every supported resume/remount path, joined by
//  IDENTITY (the declared tool_use id, or declared question/decision ids) —
//  never by display text.
//
//    §1  same-process re-presentation of the SAME tool call: no duplicate
//        questions, same ids, draft + note + focus intact;
//    §2  restart (fresh live slot) re-presenting the pending tool_use:
//        the durable session is ADOPTED — same session id, same question
//        ids, the note, the draft, and the focus all survive;
//    §3  a declared-id continuation after restart joins the same session
//        with history preserved;
//    §4  a COMPLETED durable session is never adopted — a fresh call mints
//        a fresh session;
//    §5  no identity overlap ⇒ a fresh session (adoption never guesses).
//
//  Proof hygiene: scratch-rooted MERCURY_CONFIG_DIR before any import.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'interview-resume-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')

const { checker } = await import('../engine-durability/harness.ts')
const { commitAnswer, draftAnswer, navigateTo, presentToolCall, setNote, submitInterview } =
  await import('../../src/services/interview/controller.ts')
const { flushInterviewLog, interviewSnapshot, _resetInterviewForProofs } = await import(
  '../../src/services/interview/store.ts'
)

const t = checker()

const INPUT = {
  questions: [
    {
      question: 'Which storage engine should the cache use?',
      header: 'Cache',
      options: [
        { label: 'Redis', description: 'Shared.' },
        { label: 'In-memory', description: 'Local.' },
      ],
    },
    {
      question: 'Which eviction policy fits?',
      header: 'Eviction',
      options: [
        { label: 'LRU', description: 'Recency.' },
        { label: 'LFU', description: 'Frequency.' },
      ],
    },
  ],
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — same-process re-presentation joins, never duplicates')
_resetInterviewForProofs()
const first = presentToolCall({ input: INPUT, toolUseId: 'toolu_A' })
const q1 = first.questions[0]!
const q2 = first.questions[1]!
draftAnswer(q1.id, { optionIds: [q1.options[1]!.id] })
setNote(q1.id, 'prefer local')
navigateTo(q2.id)
{
  const again = presentToolCall({ input: INPUT, toolUseId: 'toolu_A' })
  const s = interviewSnapshot()
  t.check('the same session continues', again.sessionId === first.sessionId)
  t.check('no duplicate questions minted', s.questionOrder.length === 2, `${s.questionOrder.length}`)
  t.check('the question ids are unchanged', again.questions.map(q => q.id).join(',') === [q1.id, q2.id].join(','))
  t.check('the draft survived', s.questions[q1.id]?.draft?.optionIds[0] === q1.options[1]!.id)
  t.check('the note survived', s.questions[q1.id]?.note === 'prefer local')
  t.check('the focus survived', s.focus === q2.id)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — restart: the pending tool_use adopts its durable session')
await flushInterviewLog()
_resetInterviewForProofs() // the "new process": empty live slot, durable log intact
{
  const resumed = presentToolCall({ input: INPUT, toolUseId: 'toolu_A' })
  const s = interviewSnapshot()
  t.check('the durable session was ADOPTED, not re-minted', resumed.sessionId === first.sessionId)
  t.check('the question ids survived the restart', resumed.questions.map(q => q.id).join(',') === [q1.id, q2.id].join(','))
  t.check('two questions, not four', s.questionOrder.length === 2, `${s.questionOrder.length}`)
  t.check('the draft survived the restart', s.questions[q1.id]?.draft?.optionIds[0] === q1.options[1]!.id)
  t.check('the note survived the restart', s.questions[q1.id]?.note === 'prefer local')
  t.check('the focus survived the restart', s.focus === q2.id)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — a declared-id continuation joins after restart')
await flushInterviewLog()
_resetInterviewForProofs()
{
  const round2 = presentToolCall({
    input: {
      questions: [
        {
          ...(INPUT.questions[0] as object),
          question: 'Given the eviction answer, which storage engine should the cache use?',
          id: q1.id,
          decisionId: q1.decisionId,
        } as (typeof INPUT.questions)[0],
      ],
    },
    toolUseId: 'toolu_B',
  })
  const s = interviewSnapshot()
  t.check('the declared id joined the SAME durable session', round2.sessionId === first.sessionId)
  t.check('the reworded question kept its identity', s.questions[q1.id]?.question.text.startsWith('Given the eviction'))
  t.check('its note is still attached', s.questions[q1.id]?.note === 'prefer local')
  t.check('history is intact (both questions present)', s.questionOrder.length === 2)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — a completed session is never adopted')
commitAnswer(q1.id, { optionIds: [q1.options[1]!.id] })
commitAnswer(q2.id, { optionIds: [q2.options[0]!.id] })
submitInterview({ onAllow: () => {}, onReject: () => {} }, INPUT as unknown as Record<string, unknown>)
await flushInterviewLog()
_resetInterviewForProofs()
{
  const fresh = presentToolCall({ input: INPUT, toolUseId: 'toolu_A' })
  t.check('a completed durable session stays closed', fresh.sessionId !== first.sessionId)
  t.check('the fresh session minted fresh identity', fresh.questions[0]!.id !== q1.id)
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — no identity overlap ⇒ a fresh session, never a guess')
_resetInterviewForProofs()
{
  const a = presentToolCall({ input: INPUT, toolUseId: 'toolu_X' })
  await flushInterviewLog()
  _resetInterviewForProofs()
  const b = presentToolCall({ input: INPUT, toolUseId: 'toolu_Y' })
  t.check('a different tool call with no declared ids never adopts', b.sessionId !== a.sessionId)
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-resume-remount')
