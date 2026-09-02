import { ALL_AGENTS, listCapabilityKills } from '../../utils/permissions/capabilityGate.js'

export function parseKillToken(token: string): { agentType: string; toolName: string } {
  const trimmed = (token ?? '').trim()
  const sep = trimmed.indexOf(':')
  if (sep === -1) return { agentType: ALL_AGENTS, toolName: trimmed }
  return {
    agentType: trimmed.slice(0, sep).trim() || ALL_AGENTS,
    toolName: trimmed.slice(sep + 1).trim(),
  }
}

export function scopeLabel(agentType: string): string {
  return agentType === ALL_AGENTS ? 'all agents' : `agent ${agentType}`
}

export function formatKills(): string {
  const kills = listCapabilityKills()
  const lines = Object.entries(kills).flatMap(([agent, tools]) =>
    tools.map(t => `  - \`${t}\` · ${scopeLabel(agent)}`),
  )
  return lines.length
    ? `Capabilities killed this session:\n${lines.join('\n')}`
    : 'No capabilities killed this session.'
}
