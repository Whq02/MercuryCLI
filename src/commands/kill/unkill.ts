import type { LocalCommandCall } from '../../types/command.js'
import { restoreCapability } from '../../utils/permissions/capabilityGate.js'
import { formatKills, parseKillToken, scopeLabel } from './shared.js'

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
