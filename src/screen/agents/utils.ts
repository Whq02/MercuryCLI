
import type { AgentSource } from '../../crew/agents/agentDefinition.js'
import { getSettingSourceDisplayNameCapitalized } from '../../platform/settings/settingSources.js'

export function getAgentSourceDisplayName(
  source: AgentSource | 'all',
): string {
  switch (source) {
    case 'all':
      return 'All agents'
    case 'built-in':
      return 'Built-in agents'
    case 'extension':
      return 'Extension agents'
    default:
      return getSettingSourceDisplayNameCapitalized(source)
  }
}
