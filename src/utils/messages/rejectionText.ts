// Rejection, interruption, and denial text — the canonical strings the rest of
// the harness compares against (UI renderers, HFI filters, resubmit logic all
// match on these EXACT values; the message-pipeline parity oracle pins them).
// Owned Mercury module; the
// original lived inline in utils/messages.ts.

import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'

// ── interruption / cancellation ─────────────────────────────────────────────

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."

// ── permission rejections ───────────────────────────────────────────────────

export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
export const SUBAGENT_REJECT_MESSAGE =
  'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.'
export const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX =
  'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n'
export const PLAN_REJECTION_PREFIX =
  'The agent proposed a plan that was rejected by the user. The user chose to stay in strategy mode rather than proceed with implementation.\n\nRejected plan:\n'

/** What every denial tells the model about its own next move: no other route
 * to the same effect, and a plain stop when the task needs the action. The
 * operator's side of a denial (the consent card, or how the operator can
 * allow it) is stated by the denial itself — never as something for the
 * model to arrange. */
export const DENIAL_WORKAROUND_GUIDANCE =
  `Do not try to reach the same effect by another route. ` +
  `If the task cannot continue without this action, stop and say plainly what was not run and why the task needs it, then wait for the operator.`

export function AUTO_REJECT_MESSAGE(toolName: string): string {
  return (
    `Permission to use ${toolName} has been denied: this session cannot show the operator a consent card, so the action was not run. ` +
    `The operator can allow it with a permission rule for ${toolName}, or by running the session interactively and approving it there. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}
export function DONT_ASK_REJECT_MESSAGE(toolName: string): string {
  return (
    `Permission to use ${toolName} has been denied because Mercury is running in don't ask mode: nothing that needs approval runs in this mode. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

/**
 * Classify an errored tool_result's text as a DENIAL (permission rejected,
 * auto/dont-ask/classifier denial, user interrupt/cancel) vs an ordinary tool
 * failure. The transcript's status glyphs split on this:
 * ✕ CRIMSON is reserved for denials/interrupts; a tool that merely errored
 * wears the AMBER ▲ warn lead — a failing bash command is normal work, not an
 * alarm. Matches the canonical strings above (prefix-match for the
 * reason-carrying variants; the AUTO/DONT_ASK function forms share the
 * DENIAL_WORKAROUND_GUIDANCE tail and the 'has been denied' lead).
 */
export function isDenialResultText(raw: string): boolean {
  // The tool executor wraps EVERY model-visible refusal in the transcript's
  // error wrapper (toolExecution.toolUseError — contract data, since
  // the S09 rewrite): a consent card's No lands as
  // `<tool_use_error>` + REJECT_MESSAGE + `</tool_use_error>` on both the
  // in-process and the daemon road. The canon strings below are the BARE
  // sentences, so the classifier reads through the wrapper first — or the
  // operator's own No wore the amber "ordinary failure" lead on every
  // denied tool row (lifecycle-cards C3, red since the rewrite).
  const text = unwrapToolUseError(raw)
  return (
    text.includes(INTERRUPT_MESSAGE) ||
    text.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE) ||
    text === CANCEL_MESSAGE ||
    text === REJECT_MESSAGE ||
    text.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text === SUBAGENT_REJECT_MESSAGE ||
    text.startsWith(SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text.startsWith(PLAN_REJECTION_PREFIX) ||
    text.startsWith(AUTO_MODE_REJECTION_PREFIX) ||
    (text.includes(' has been denied') && text.includes(DENIAL_WORKAROUND_GUIDANCE))
  )
}

/** The transcript's tool-error wrapper (toolExecution.toolUseError), read
 *  through: the bare text inside one outer `<tool_use_error>` pair, or the
 *  text itself when it wears none. Self-contained on purpose — messages/text
 *  imports this module, so its extractTag cannot be imported here. */
export function unwrapToolUseError(text: string): string {
  const match = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(text)
  return match === null ? text : match[1]!
}

export const NO_RESPONSE_REQUESTED = 'No response requested.'

/** Synthetic tool_result content inserted by ensureToolResultPairing when a
 * tool_use has no matching tool_result. Exported so HFI submission can reject
 * any payload containing it — the placeholder satisfies pairing structurally,
 * but the content is fake and would poison training data if submitted. */
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'

// ── flow-classifier denials ─────────────────────────────────────────────────

/** UI detection prefix: classifier denials render as a short summary. */
const AUTO_MODE_REJECTION_PREFIX =
  'Permission for this action has been denied. Reason: '

export function isClassifierDenial(content: string): boolean {
  return content.startsWith(AUTO_MODE_REJECTION_PREFIX)
}

/** Denial text for a flow-classifier block in a session that cannot show
 * the operator a consent card (a prompt-less agent or a non-interactive
 * run): what was blocked and why, how the operator can allow it, and what
 * the model does next. A session with a card never sends this — there the
 * block is the operator's decision on the card. */
export function buildYoloRejectionMessage(reason: string): string {
  return (
    `${AUTO_MODE_REJECTION_PREFIX}${reason}. ` +
    `Flow's safety check blocked this action, and this session cannot show the operator a consent card, so it was not run. ` +
    `The operator can allow it with a permission rule for the action, or by running the session interactively and approving it there. ` +
    `Work that does not depend on this action can continue. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

/** Denial text for a flow-classifier block of an action the operator already
 * declined on the consent card earlier in this turn: no second card, and the
 * operator's answer stands. */
export function buildFlowBlockDeclinedMessage(reason: string): string {
  return (
    `${AUTO_MODE_REJECTION_PREFIX}${reason}. ` +
    `The operator was asked about this same action earlier in this turn and declined it, so it was not asked again and was not run. ` +
    `Follow what the operator said. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

/** Shown when the classifier itself is unavailable in a session with no
 * consent card (a session with one hands the ask to the operator instead):
 * what was not run and why, that the check may recover, and which tools
 * never need it. The read-only note names the BUILT-IN tools precisely —
 * MCP tools always ride the classifier, so "any read-only operation" would
 * send the model into a denial loop. */
export function buildClassifierUnavailableMessage(
  toolName: string,
  classifierModel?: string,
): string {
  const modelDetail = classifierModel ? ` (last tried ${classifierModel})` : ''
  return (
    `The flow safety check is temporarily unavailable${modelDetail}, so ${toolName} was not run: flow runs nothing its check has not cleared, and this session cannot show the operator a consent card. ` +
    `The check may recover shortly, and the same action can be tried again then; work that does not need the check can continue. ` +
    `The built-in read-only tools (file reads, code search, glob listings) never need the check; MCP tools always do.`
  )
}

// ── memory-correction nudge ─────────────────────────────────────────────────

const MEMORY_CORRECTION_HINT =
  "\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."

/** Appends the memory-correction nudge to a rejection/cancellation message
 * when auto-memory is enabled and the rollout flag is on. */
export function withMemoryCorrectionHint(message: string): string {
  const armed =
    isAutoMemoryEnabled() &&
    getFeatureValue_CACHED_MAY_BE_STALE('mercury_memory_correction_hint', false)
  return armed ? message + MEMORY_CORRECTION_HINT : message
}
