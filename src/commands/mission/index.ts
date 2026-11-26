import { getIsNonInteractiveSession } from '../../boot/process-state/processState.js'
import type { Command } from '../catalogue/commands.js'


export const mission: Command = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '[<goal> | clear|cancel]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./mission-jsx.js'),
}

export const missionNonInteractive: Command = {
  type: 'local',
  name: 'goal',
  supportsNonInteractive: true,
  description: 'Set a goal — keep working until the condition is met',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./mission.js'),
}

export default mission
