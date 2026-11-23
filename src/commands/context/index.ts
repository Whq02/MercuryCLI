import { getIsNonInteractiveSession } from '../../boot/process-state/processState.js'
import type { Command } from '../catalogue/commands.js'

export const context: Command = {
  type: 'local-jsx',
  name: 'context',
  description: 'Chart the context window — a colored cell map of what fills it',
  isEnabled: () => !getIsNonInteractiveSession(),
  scope: 'agent',
  load: () => import('./context.js'),
}

export const contextNonInteractive: Command = {
  type: 'local',
  name: 'context',
  description: 'Print the context-window breakdown',
  isEnabled: () => getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  supportsNonInteractive: true,
  scope: 'agent',
  load: () => import('./contextHeadless.js'),
}
