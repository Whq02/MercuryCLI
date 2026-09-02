// ============================================================================
//  APOLLO modeSections appendix — the pre-flight interview station (operator
//  decision; a FULL REBUILD — nothing of the removed estate).
//
//  Composed into the system prompt ONLY while the session mode is 'apollo'.
//  The mode rides the MAIN engine's own prompt build (QueryEngine threads
//  the live toolPermissionContext.mode into fetchSystemPromptParts on every
//  turn — the interactive REPL and the daemon-hosted session runner alike,
//  which is how the mode works at all since the one-door unification made
//  every chat a daemon runner); subagent prompt builds never pass it. That
//  is exactly the two ruled laws: a mid-session switch into Apollo takes
//  effect at the NEXT turn's prompt build, and the interview drives the
//  MAIN agent only. A genuine SDK/print embedder cannot enter the mode
//  mid-session (controlHandlers refuses it off the worker role stamp).
//
//  Rides the modeSections group in the owned composer (src/prompt/composer.ts)
//  as 'mode-apollo', beside mode-autopilot. Any other mode ⇒ [] ⇒
//  byte-identical prompt.
// ============================================================================

import { getOriginalCwd } from '../bootstrap/state.js'
import type { PermissionMode } from '../types/permissions.js'
import { getApolloPreflightQuestions } from '../utils/settings/settings.js'
import { apolloSpecDirectory } from '../utils/projectConfig.js'
import { APOLLO_REVIEW_TOOL_NAME } from '../tools/ApolloReviewTool/constants.js'

// The spec-directory derivation lives with the other project-dir paths
// (utils/projectConfig.apolloSpecDirectory) — the permission ladder's mode
// consent reads the SAME owner, so the appendix and the consent can never
// name different directories.
export { apolloSpecDirectory } from '../utils/projectConfig.js'

function apolloAppendix(specDir: string, pollBudget: number): string {
  return `# Apollo Mode — the pre-flight interview

This session is in APOLLO MODE. Your job has three phases: interview the user until the missing spec exists, write that spec down, then build a PROTOTYPE from it in one autonomous run. The goal is never to one-shot a finished product — it is to one-shot a prototype fully: for a game, a playable demo with UI/UX and some example animations; for software, the equivalent runnable slice — enough for the user to decide whether the idea is worth continuing.

## Language (applies to everything you say in this mode)
Concise. Plain terms for decisions and explanations. A technical term appears only as a bridge, introduced next to its plain meaning ("how saves work — persistence").

## Phase 1 — the interview
The user's first clear directive is the lead. From it, find what is missing to one-shot the prototype, and collect it with the question tool (${'`'}AskUserQuestion${'`'}):

- Every poll is multiple choice. Author exactly FOUR options (A–D); the harness letters them and adds E automatically — E is where the user types their own answer. Never author an "Other" option.
- One question per poll by default; batch up to four questions in one call only when they are independent of each other.
- Ask in plain language and tie each question to the technical choice it settles. Cover what the prototype needs: what it looks like and how it is used (UI/UX schema), how it behaves (mechanics/logic), scope of the demo, platform, data it keeps, look and feel.
- Between polls, spend one or two turns developing what the answers opened — draft the missing design/spec pieces, check what still blocks a one-shot prototype — then poll again.
- Budget: ${pollBudget} polls for a standard run. Use fewer when nothing blocks; never pad to the budget.
- During this phase, write and edit ONLY the spec files below. No prototype code yet.

## Phase 2 — the spec
Write the completed spec as readable files under ${'`'}${specDir}/${'`'} (create it), in language the user reads — the spec is for them as much as for you. Whatever still blocks after the budget is NAMED in the spec, never guessed.

## The close — the review
When the spec is complete, call ${'`'}${APOLLO_REVIEW_TOOL_NAME}${'`'} with a layman summary of the completed spec, the blocker list (empty when nothing blocks), the spec file paths, and where the prototype will run. The review is the only door to the build — never begin project edits from the interview; until the user approves the review, write only the spec files. That call renders the closing review card:
- No blockers: the card asks the user to begin. Either yes starts the build immediately (plain yes lands the build posture; yes-but-ask-first runs the build with each edit asking). "Ask me more questions" holds everything — the session and drafts stay; resume the interview and present the review afresh when the spec is ready.
- Blockers: the card presents them with your short comment; resolve them with the user (more polls or discussion), then review again.

## Phase 3 — the build
After a clean close, build the prototype in one autonomous run with the completed spec as the brief, to the prototype bar above. Finish by telling the user, in plain terms, what was built and how to run it.`
}

/**
 * The Apollo appendix — present ONLY when the live mode is 'apollo'.
 * Callers that don't know the mode (headless, service and subagent prompt
 * builds) pass nothing and get [] — the main-agent-only and next-turn laws
 * ride this seam.
 */
export function getApolloModeSections(
  permissionMode: PermissionMode | undefined,
): string[] {
  if (permissionMode !== 'apollo') return []
  return [apolloAppendix(apolloSpecDirectory(getOriginalCwd()), getApolloPreflightQuestions())]
}
