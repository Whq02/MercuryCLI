import type { Command } from '../../commands.js'
import { isCrewEnabled } from '../../utils/crewEnabled.js'

const fleet = {
  type: 'local-jsx',
  immediate: true,
  name: 'fleet',
  needsConcourse: true,
  description:
    'Open the Mercury fleet command-center — missions, agents, leases for the crew',
  isEnabled: () => isCrewEnabled(),
  load: () => import('./fleet.js'),
} satisfies Command

export default fleet
