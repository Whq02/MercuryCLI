import type { LocalCommandCall } from '../../types/command.js'
import { killCapability } from '../../utils/permissions/capabilityGate.js'
import { formatKills, parseKillToken, scopeLabel } from './shared.js'

// `/kill` — disable a tool/capability at runtime (the kill-switch was env-only until
// now; this calls the already-exported, deny-only killCapability). No arg ⇒ list the
// current kills. Deny-only by construction: it can only REFUSE a tool, never grant one,
// so the worst case is denying a tool (fail-safe). The enforcement floor is untouched.
export const call: LocalCommandCall = async (args, _context) => {
  const arg = (args ?? '').trim()
  if (!arg) {
    return {
      type: 'text',
      value: `${formatKills()}\n\nUsage: \`/kill <tool>\` (all agents) or \`/kill <agent>:<tool>\` · restore with \`/unkill\`.`,
    }
  }
  const { agentType, toolName } = parseKillToken(arg)
  if (!toolName) {
    return { type: 'text', value: 'Usage: `/kill <tool>` or `/kill <agent>:<tool>`' }
  }
  killCapability(agentType, toolName)
  return {
    type: 'text',
    value: `Killed \`${toolName}\` for ${scopeLabel(agentType)} this session — it will be refused at the gate. Restore with \`/unkill ${arg}\`.`,
  }
}
