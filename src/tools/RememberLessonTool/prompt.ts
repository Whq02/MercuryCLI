import { experienceCardsEnabled } from '../../memdir/experienceCards.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'

export const REMEMBER_LESSON_TOOL_NAME = 'RememberLesson'

/**
 * Gate: Mercury's experience-card lifecycle (experienceCardsEnabled — MERCURY_EXPERIENCE_CARDS,
 * default-ON) AND auto-memory must both be live. OFF (MERCURY_EXPERIENCE_CARDS=0 /
 * auto-memory disabled) ⇒ the tool is absent ⇒ byte-identical.
 */
export function isRememberLessonEnabled(): boolean {
  return experienceCardsEnabled() && isAutoMemoryEnabled()
}

export const REMEMBER_LESSON_DESCRIPTION =
  'Bank a transferable engineering lesson you VERIFIED this session as an experience card (a candidate the operator promotes to trust). Use after a green-gate-passing fix when the lesson would help a future session — not for task notes or unverified beliefs.'

export function buildRememberLessonPrompt(): string {
  return `Bank a TRANSFERABLE lesson as an experience card so a FUTURE session recalls it. Use when verified work this session taught something durable — a gotcha, an invariant, a pattern for THIS codebase — not speculation and not a restatement of the task.

The card is born a CANDIDATE (unverified): it surfaces in recall marked as such until the operator promotes it to trust. Secret-bearing or trivial input is refused; a near-duplicate of an existing lesson is deduped (no clutter).

## When to use
- After a green-gate-passing fix that taught a non-obvious, reusable lesson → set greenGatePassed: true.
- NOT for task-specific notes, restating what you did, or anything you believe but did not verify (those are refused as low-signal).

## Input
- problemClass: a short kebab category (e.g. "cross-process-locking", "fork-gating") — the dedup + recall key.
- lesson: the transferable lesson itself (the card body) — concrete and actionable, ANCHORED to the observed execution signal that taught it (the command you ran, the file/line you read, the gate that passed/failed), NOT a narrated story or a belief. Ground the claim in what you actually saw.
- title: a one-line human title.
- summary: a one-line index hook.
- sourceRefs: commit SHAs / file paths the lesson came from — the captured anchor for the body (scanned for secrets too). Supply them so the lesson points at real signal, not a story.
- appliesWhen / notWhen (optional): one-line regime cues — when this lesson applies, and when it must NOT be recalled as universal advice.
- greenGatePassed: did the originating work pass the project green-gate? Only bank lessons from verified work; false + no operator signal ⇒ refused as not-high-signal.`
}
