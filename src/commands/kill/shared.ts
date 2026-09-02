// Shared parse/format for the /kill + /unkill capability-toggle commands.
// The grammar MIRRORS seedFromEnv (MERCURY_KILL): a bare `tool` kills it for ALL
// agents (the ALL_AGENTS '*' key), `agent:tool` scopes it to one agent type.
// Using ALL_AGENTS (not undefined) for the bare case is load-bearing: isCapabilityKilled
// checks the specific-agent key OR the '*' key — never normalizeAgentType(undefined)='' —
// so a kill stored under '' would never enforce.
import { ALL_AGENTS, listCapabilityKills } from '../../utils/permissions/capabilityGate.js'

/** Parse a `tool` | `agent:tool` token into (agentType, toolName), mirroring MERCURY_KILL. */
export function parseKillToken(token: string): { agentType: string; toolName: string } {
  const trimmed = (token ?? '').trim()
  const sep = trimmed.indexOf(':')
  if (sep === -1) return { agentType: ALL_AGENTS, toolName: trimmed }
  return {
    agentType: trimmed.slice(0, sep).trim() || ALL_AGENTS,
    toolName: trimmed.slice(sep + 1).trim(),
  }
}

/** Human-readable scope for a kill ('all agents' for the '*' key, else `agent <type>`). */
export function scopeLabel(agentType: string): string {
  return agentType === ALL_AGENTS ? 'all agents' : `agent ${agentType}`
}

/** A summary of the kills currently held in the runtime store (listCapabilityKills). */
export function formatKills(): string {
  const kills = listCapabilityKills()
  const lines = Object.entries(kills).flatMap(([agent, tools]) =>
    tools.map(t => `  - \`${t}\` · ${scopeLabel(agent)}`),
  )
  return lines.length
    ? `Capabilities killed this session:\n${lines.join('\n')}`
    : 'No capabilities killed this session.'
}
