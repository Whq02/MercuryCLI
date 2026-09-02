import type { LocalCommandCall } from '../../types/command.js'
import { restoreCapability } from '../../utils/permissions/capabilityGate.js'
import { formatKills, parseKillToken, scopeLabel } from './shared.js'

// `/unkill` — re-enable a tool/capability previously killed this session. Lifts only
// kills held in the runtime store (it does NOT override a MERCURY_AGENT_CAP per-agent
// posture); pass the SAME token grammar /kill used. No arg ⇒ list the current kills.
export const call: LocalCommandCall = async (args, _context) => {
  const arg = (args ?? '').trim()
  if (!arg) {
    return {
      type: 'text',
      value: `${formatKills()}\n\nUsage: \`/unkill <tool>\` or \`/unkill <agent>:<tool>\` (the same token you killed).`,
    }
  }
  const { agentType, toolName } = parseKillToken(arg)
  if (!toolName) {
    return { type: 'text', value: 'Usage: `/unkill <tool>` or `/unkill <agent>:<tool>`' }
  }
  restoreCapability(agentType, toolName)
  return {
    type: 'text',
    value: `Restored \`${toolName}\` for ${scopeLabel(agentType)}.\n\n${formatKills()}`,
  }
}
