import type { Command } from '../../commands.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

const fleet = {
  type: 'local-jsx',
  immediate: true,
  name: 'fleet',
  needsConcourse: true,
  description:
    'Open the Mercury fleet command-center — missions, agents, leases for the team',
  // Swarms-gated; --agent-teams is the one external opt-in.
  isEnabled: () => isAgentSwarmsEnabled(),
  load: () => import('./fleet.js'),
} satisfies Command

export default fleet
