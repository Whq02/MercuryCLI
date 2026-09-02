// Display name for an agent's definition source.

import type { AgentSource } from '../../tools/AgentTool/loadAgentsDir.js'
import { getSettingSourceDisplayNameCapitalized } from '../../utils/settings/constants.js'

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
