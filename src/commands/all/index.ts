import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import { scribeBusLiveEnabled } from '../../utils/scribe/scribeGates.js'
import { buildNote, serializeScribeEnvelope, OPERATOR_BROADCAST_LABEL } from '../../utils/scribe/scribeBus.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { logForDebugging } from '../../utils/debug.js'

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
  const labeled = `${OPERATOR_BROADCAST_LABEL} ${message}`
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
