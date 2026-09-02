// ============================================================================
//  realConversation — does the transcript hold a REAL conversation, or only
//  local-command chrome?
//
//  The hero-in-the-feed fix collapses the MercuryHome landing to the
//  one-line brand row "once turns exist" — but its first predicate was
//  `renderableMessages.length > 0`, and a LOCAL slash command leaves renderable
//  messages behind without any conversation having happened: /model appends the
//  `<command-name>` breadcrumb + the `<local-command-stdout>Set model to …` ack
//  (createModelSwitchBreadcrumbs / processSlashCommand), so switching models on
//  a fresh cockpit vanished the mascot and stranded a naked brand row above a
//  top-anchored capsule (operator screenshot, same day). "Turns exist" must
//  mean CONVERSATION — assistant output, tool activity, or a user message that
//  actually goes to the model — never the furniture a local command leaves.
//
//  FURNITURE (does not count as conversation):
//    · isMeta user rows (the local-command caveat, injected context)
//    · `<command-name>` / `<command-message>` slash-command breadcrumbs
//    · `<local-command-stdout>` / `<local-command-stderr>` local acks
//    · `<local-command-caveat>` (belt-and-suspenders under isMeta)
//    · `type: 'system'` notice rows (the resume recap card, memory-saved,
//      room-event lines — harness furniture; a bare `--resume` of a
//      chrome-only session must land on the landing, not the brand row)
//    · the synthetic resume-assistant sentinel ("No response requested." —
//      conversationRecovery appends it to make an interrupted transcript
//      API-valid; it renders INVISIBLY and already poisoned the recap card
//      once — awaySummary.ts isSyntheticResumeAssistant is the precedent)
//  REAL (counts): everything else — plain prompts, `<bash-input>` runs and
//  their stdout (arbitrary-length content: exactly the scrolled-junk case the
//  collapse exists for), tool_results, real assistant / progress rows.
//
//  A LEAF module (constants/xml only) so proofs bun-import it directly (the
//  proof-loadability doctrine); Messages.tsx consumes it for the LogoHeader
//  landing swap.
// ============================================================================
import {
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'

/** The minimal shape this predicate reads — structural, so Message,
 *  NormalizedMessage and RenderableMessage all fit without casts. */
export type ConversationSignalMessage = {
  readonly type: string
  readonly isMeta?: boolean | undefined
  readonly message?: { readonly content?: unknown } | undefined
}

// Mirror the RENDERER's classification (UserTextMessage.tsx): whatever paints
// as command chrome must not count as conversation. `includes` matching like
// the renderer; the stdout/stderr marks stay prefix-open (no closing `>`) to
// match its startsWith checks.
const NOISE_MARKS = [
  `<${COMMAND_NAME_TAG}>`,
  `<${COMMAND_MESSAGE_TAG}>`,
  `<${LOCAL_COMMAND_STDOUT_TAG}`,
  `<${LOCAL_COMMAND_STDERR_TAG}`,
  `<${LOCAL_COMMAND_CAVEAT_TAG}>`,
] as const

// utils/messages.ts NO_RESPONSE_REQUESTED, mirrored as a literal so this stays
// a leaf (awaySummary.ts precedent); prove-home-hero-noise.ts drift-guards the
// two against each other.
const NO_RESPONSE_SENTINEL = 'No response requested.'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (
      block != null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (out ? '\n' : '') + (block as { text: string }).text
    }
  }
  return out
}

/** True when a row is transcript FURNITURE — local-command chrome (breadcrumb /
 *  ack / caveat), an isMeta user row, or a system notice — not conversation. */
export function isTranscriptFurnitureMessage(
  msg: ConversationSignalMessage,
): boolean {
  // System notices (away recap, memory saved, room events…) are the harness
  // talking, not the conversation — a resumed chrome-only session carries one
  // and must still read as "no conversation yet".
  if (msg.type === 'system') return true
  // The resume loader's API-validity sentinel: an assistant row whose SOLE
  // block is the "No response requested." text (rendered invisibly). Same
  // single-block exact-text shape awaySummary.ts's isSyntheticResumeAssistant
  // pins — an assistant row that also carries tool_use stays real.
  if (msg.type === 'assistant') {
    const content = msg.message?.content
    if (typeof content === 'string') return content === NO_RESPONSE_SENTINEL
    if (Array.isArray(content) && content.length === 1) {
      const b = content[0] as { type?: unknown; text?: unknown }
      return b?.type === 'text' && b.text === NO_RESPONSE_SENTINEL
    }
    return false
  }
  if (msg.type !== 'user') return false
  if (msg.isMeta === true) return true
  const text = textOf(msg.message?.content)
  if (text.length === 0) return false // tool_result-only user rows = real work
  return NOISE_MARKS.some(mark => text.includes(mark))
}

/** Does this renderable transcript hold any REAL conversation? False while the
 *  session carries nothing but furniture — the landing (mascot + lockup)
 *  stays; flips true at most once per session, on the first real row. */
export function hasRealConversation(
  messages: readonly ConversationSignalMessage[],
): boolean {
  for (const m of messages) if (!isTranscriptFurnitureMessage(m)) return true
  return false
}
