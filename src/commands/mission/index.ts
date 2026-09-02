import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'


export const mission: Command = {
  type: 'local-jsx',
  name: 'mission',
  description: 'Set a mission — keep working until the condition is met',
  argumentHint: '[<condition> | clear|cancel]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./mission-jsx.js'),
}

export const missionNonInteractive: Command = {
  type: 'local',
  name: 'mission',
  supportsNonInteractive: true,
  description: 'Set a mission — keep working until the condition is met',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./mission.js'),
}

export default mission
