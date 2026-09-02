import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import { scribeBusLiveEnabled } from '../../utils/scribe/scribeGates.js'
import { buildNote, serializeScribeEnvelope, OPERATOR_BROADCAST_LABEL } from '../../utils/scribe/scribeBus.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * /all — the operator's BROADCAST to BOTH agents (#47).
 *
 * `/all <message>` reaches the Scribe AND the Implementer DIRECTLY, labeled
 * `[operator broadcast]`, BYPASSING the normal operator→Scribe→refine→dispatch flow:
 * the Implementer gets it as a `note` envelope written straight to its inbox (CONTEXT,
 * not a dispatch — the daemon delivers it to stdin like a control and it never consumes
 * the one-dispatch-at-a-time budget), AND the foreground Scribe gets it as the command's
 * labeled return value. Both packs brief their agent on the `[operator broadcast]` marker
 * so neither breaks on it: the Scribe does NOT re-refine/re-dispatch it (the Implementer
 * already has it); the Implementer reads it as authoritative context, not a task, and
 * still escalates to the Scribe, never the human.
 *
 * Honest when the daemon is off: the Scribe half always lands, but the Implementer half
 * is delivered only by a running daemon — so when the live bus is off (or the write
 * failed) the returned text SAYS the Implementer half is queued, not delivered.
 *
 * Fork- + scribe-gated (isEnabled), supportsNonInteractive. OFF ⇒ never offered ⇒
 * operator→Scribe-only (byte-identical).
 */
const TEAM = 'scribe'
const IMPLEMENTER = 'implementer'

const call: LocalCommandCall = async args => {
  const message = (args ?? '').trim()
  if (!message) {
    return {
      type: 'text',
      value:
        '/all <message> — BROADCAST one message to BOTH the Scribe and the Implementer at once, ' +
        'labeled [operator broadcast], bypassing the normal refine→dispatch flow. Without /all, your ' +
        'messages go to the Scribe only (the Implementer never sees raw intent).',
    }
  }
  // Route a BROADCAST note to the Implementer's inbox (the daemon drains it to stdin,
  // labeled [operator broadcast]). A note never steals the dispatch budget. The Scribe
  // half (the labeled return below) always lands; the Implementer half needs a running
  // daemon, so be HONEST on-screen when it can't deliver right now.
  let routed = false
  try {
    routed = await writeToMailbox(
      IMPLEMENTER,
      {
        from: TEAM_LEAD_NAME,
        text: serializeScribeEnvelope(buildNote(TEAM_LEAD_NAME, message, { broadcast: true })),
        timestamp: new Date().toISOString(),
      },
      TEAM,
    )
  } catch (e) {
    logForDebugging(`[/all] writeToMailbox failed: ${e}`)
    routed = false
  }
  // The labeled value reaches the Scribe's model context verbatim (via <local-command-stdout>
  // → a user turn). It is the exact token both packs quote, so the Scribe recognizes it.
  const labeled = `${OPERATOR_BROADCAST_LABEL} ${message}`
  // Honest surfacing: the Implementer half is delivered only by a running daemon draining
  // its inbox. If the bus is off or the write failed, say so instead of looking successful.
  const implementerLive = routed && scribeBusLiveEnabled()
  if (!implementerLive) {
    logForDebugging('[/all] Implementer half queued, not delivered (bus off / write failed)')
    return {
      type: 'text',
      value:
        labeled +
        '\n\n(Queued for the Implementer — it will see this broadcast once the backend daemon is running.)',
    }
  }
  return { type: 'text', value: labeled }
}

const all = {
  type: 'local',
  name: 'all',
  description: 'Broadcast one message to BOTH the Scribe and the Implementer (#47, labeled [operator broadcast])',
  isEnabled: () => isScribeModeOn(),
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default all
