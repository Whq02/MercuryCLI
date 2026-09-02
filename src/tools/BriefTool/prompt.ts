// The Brief tool's identity constants + every prompt/enforce string the
// Brief clusters import.
//
// Contract data (byte-exact, never respelled): the two tool names, the
// registered description, the feature-gate key, and the TWO sentinels — the
// stop hooks match sentinels with .includes() against PERSISTED transcript
// messages, so a respelled sentinel breaks once-per-session dedup across a
// resume of a transcript written by the previous build.
//
// Structural rule: the gate reads in getBriefEnforceText stay LAZY —
// module-scope imports of the feature-gate or augur owners would drag
// their dependency graphs onto this leaf and break bun-run loadability.

/** The wire/persisted tool name (contract data). */
export const BRIEF_TOOL_NAME = 'SendUserMessage'

/** The retired wire name, still matched in persisted transcripts. */
export const LEGACY_BRIEF_TOOL_NAME = 'Brief'

/** The tool's registered description (contract data). */
export const DESCRIPTION = 'Put a progress note in front of the user'

/** The default SendUserMessage tool description. */
export const BRIEF_TOOL_PROMPT = `Put a message in front of the user. What you place in \`message\` is the message the user actually reads — text you emit outside this tool lands only in the detail view, not in front of them.

Parameters:
- \`message\`: the message body. Markdown is supported.
- \`attachments\` (optional): files to hand the user alongside the message. Each entry is EITHER a path string for a file readable from here (absolute or cwd-relative), OR the exact device-file object you were given — \`{file_uuid, file_name, size, is_image}\` — passed through verbatim, all four keys intact.
- \`status\`: what kind of message this is. \`'normal'\` for an answer to what the user just said or asked. \`'proactive'\` when you are surfacing something they did not just ask about — finished background work, an obstacle that needs their decision, a status change worth interrupting for. Label honestly; downstream routing consumes it.`

/** The tighter Augur tool-arm variant of the description. */
export const AUGUR_TOOL_PROMPT = `Send the user a message mid-turn. Reserve it for verbatim-quality content produced between tool calls — a finding worth reading exactly as written, a decision they need to weigh in on, an artifact of the work itself.

Do not route routine progress narration through it, and do not use it for your final answer — ordinary text serves both of those.

Parameters:
- \`message\`: the message body (markdown supported).
- \`attachments\` (optional): path strings readable from here, or the exact \`{file_uuid, file_name, size, is_image}\` device object passed through verbatim.
- \`status\`: \`'normal'\` for a reply to what the user just said; \`'proactive'\` for something unrequested that needs their attention now. Label it honestly.`

/** The system-prompt section teaching the away-session messaging contract. */
export const BRIEF_PROACTIVE_SECTION = `## Talking to the user

Your replies to the user go through the ${BRIEF_TOOL_NAME} tool — every reply, including trivial ones ("done", "yes, that worked"). Plain text is not a delivery channel here.

For anything longer than a quick answer: acknowledge first with a short message, do the work, then send the result. While working, message only at genuinely informative checkpoints — a material finding, a blocker, a change of direction — never a play-by-play.

Write tight, second-person messages: what happened, what it means for them, what (if anything) you need.

The reply has exactly one channel per turn: a ${BRIEF_TOOL_NAME} call IS the reply, so nothing that follows it should repeat what the call already carried — no summary line after the tool call, and no sign-off that re-announces a heading the worklog already gave.`

/** Feature-gate key for an operator-served enforce-text override (contract
 *  data — the spelling is the registered gate key). */
export const ASSISTANT_BRIEF_STOP_HOOK_TEXT_FLAG = 'mercury_assistant_brief_stop_hook_text'

/** Matched with .includes() against persisted transcripts (contract data). */
export const BRIEF_ENFORCE_SENTINEL = `You ended the turn without calling ${BRIEF_TOOL_NAME}.`

/** Matched with .includes() against persisted transcripts (contract data). */
export const BRIEF_RECAP_SENTINEL = `You emitted plain text after your ${BRIEF_TOOL_NAME} call this turn.`

/** The once-per-session teaching that follows BRIEF_RECAP_SENTINEL. */
export function getBriefRecapText(): string {
  return `The ${BRIEF_TOOL_NAME} call IS your reply — fold everything you want the user to read into that ONE call and end the turn there. From your next turn onward, send exactly one ${BRIEF_TOOL_NAME} message and emit no plain text after it. Do not resend the message you already delivered, and do not reply to this reminder.`
}

/** The enforce reminder that follows BRIEF_ENFORCE_SENTINEL (default arm). */
export const ASSISTANT_BRIEF = `Only the ${BRIEF_TOOL_NAME} tool reliably reaches the user — plain text is a best-effort local fallback they may or may not be looking at. Make the ${BRIEF_TOOL_NAME} call now, carrying the actual reply this turn owes. This turn's reply travels on a single channel: the call carries all of it, and no plain text comes after the call. Never mention this reminder to the user. If you genuinely have nothing to say, end the turn without calling the tool.`

/** The Augur brief-arm variant of the enforce reminder. */
export const AUGUR_BRIEF = `Only a ${BRIEF_TOOL_NAME} call reaches the user. Send exactly one verbatim-quality message carrying what this turn produced — no meta-commentary, no narration of the work, nothing after the call. If there is nothing worth showing, end the turn without calling the tool.`

/**
 * The active enforce text: an operator-served gate value (read as a
 * cached-may-be-stale string) overrides everything; otherwise the Augur
 * brief arm selects its variant. Both requires are deliberately lazy —
 * the gate dependencies stay OFF this module's import graph.
 */
export function getBriefEnforceText(): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const featureGates =
    require('../../services/analytics/featureGates.js') as typeof import('../../services/analytics/featureGates.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const served = featureGates.getFeatureValue_CACHED_MAY_BE_STALE(
    ASSISTANT_BRIEF_STOP_HOOK_TEXT_FLAG,
    '',
  )
  if (typeof served === 'string' && served !== '') return served
  /* eslint-disable @typescript-eslint/no-require-imports */
  const augur =
    require('../../utils/model/augur.js') as typeof import('../../utils/model/augur.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (augur.isAugurBrief()) return AUGUR_BRIEF
  return ASSISTANT_BRIEF
}
