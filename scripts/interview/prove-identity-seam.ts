#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-identity-seam.ts — Minerva, Console, and
//  the cockpit address the SAME interview/decision identity. One handle —
//  `currentInterviewRef()` on the ONE session authority — feeds every
//  surface; no private approximation exists.
//
//    §1  the ref derives from the live authority: session + focused
//        decision; discussion wins focus; review falls to session scope;
//        completion/cancel clears it;
//    §2  the surfaces consume THE handle: the console defaults ask
//        parentage to it (explicit --origin still wins), Minerva's session
//        context carries it BY REFERENCE, and the side-question engine
//        echoes parentage verbatim into its attachable result;
//    §3  the cockpit and the handle read the SAME snapshot object — the
//        identity cannot fork.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'interview-seam-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')

const { checker } = await import('../engine-durability/harness.ts')
const { commitAnswer, navigateTo, presentToolCall, requestDiscussion, cancelInterview } =
  await import('../../src/services/interview/controller.ts')
const { currentInterviewRef, interviewSnapshot, _resetInterviewForProofs } = await import(
  '../../src/services/interview/store.ts'
)
const { toContextItem } = await import('../../src/utils/sideQuestion.ts')

const t = checker()

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the ref derives from the live authority')
_resetInterviewForProofs()
t.check('no session ⇒ no ref', currentInterviewRef() === null)
const { sessionId, questions } = presentToolCall({
  input: {
    questions: [
      { question: 'Which engine?', header: 'Cache', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] },
      { question: 'Which policy?', header: 'Eviction', options: [{ label: 'C', description: 'c' }, { label: 'D', description: 'd' }] },
    ],
  },
  toolUseId: 'toolu_seam',
})
const q1 = questions[0]!
const q2 = questions[1]!
t.check(
  'the ref names the session AND the focused decision',
  currentInterviewRef() === `mercury://interview/${sessionId}/${q1.decisionId}`,
  currentInterviewRef() ?? 'null',
)
navigateTo(q2.id)
t.check('focus movement moves the decision', currentInterviewRef() === `mercury://interview/${sessionId}/${q2.decisionId}`)
requestDiscussion({ onAllow: () => {}, onReject: () => {} }, { questions: [] }, q1.id)
t.check('the DISCUSSED decision wins while discussing', currentInterviewRef() === `mercury://interview/${sessionId}/${q1.decisionId}`)
// The return (a fresh presentation joining the session) restores asking.
presentToolCall({ input: { questions: [{ question: 'Which engine?', header: 'Cache', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] }, toolUseId: 'toolu_seam' })
navigateTo('review')
t.check('review falls to session scope (no single decision)', currentInterviewRef() === `mercury://interview/${sessionId}`)
commitAnswer(q1.id, { optionIds: [q1.options[0]!.id] })
cancelInterview({ onAllow: () => {}, onReject: () => {} })
t.check('a closed session clears the ref', currentInterviewRef() === null)

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — every surface consumes THE handle')
{
  const consoleSrc = readFileSync('src/commands/console/console.tsx', 'utf8')
  t.check(
    'the console defaults ask parentage to the live interview',
    (consoleSrc.match(/currentInterviewRef\(\)/g) ?? []).length >= 2,
  )
  t.check(
    'an explicit --origin still wins over the default',
    /originMatch\?\.\[1\] !== undefined\s*\?\s*decodeURIComponent\(originMatch\[1\]\)\s*:\s*\(currentInterviewRef\(\) \?\? undefined\)/s.test(consoleSrc),
  )
  const promptSrc = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
  t.check(
    "Minerva's session context carries the interview BY REFERENCE",
    promptSrc.includes('const interviewRef = currentInterviewRef()') &&
      promptSrc.includes('`live interview: ${interviewRef}`'),
  )
  const echoed = toContextItem(
    {
      response: 'the trade-off is X',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      originRef: 'mercury://interview/is_x/id_y',
      question: 'which?',
    },
    5,
  )
  t.check(
    'the side-question engine echoes parentage VERBATIM into its result',
    echoed?.originRef === 'mercury://interview/is_x/id_y',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — the cockpit and the handle read the same snapshot')
{
  _resetInterviewForProofs()
  const p = presentToolCall({
    input: { questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] },
    toolUseId: 'toolu_same',
  })
  const snap = interviewSnapshot()
  const ref = currentInterviewRef()!
  t.check('the ref is built from the very snapshot the card renders', ref.includes(snap.sessionId!) && ref.endsWith(snap.questions[snap.focus as string]!.question.decisionId))
  void p
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-identity-seam')
