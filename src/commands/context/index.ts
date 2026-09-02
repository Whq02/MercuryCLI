import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'

/**
 * One name, an interactive/non-interactive pair whose `isEnabled` gates are
 * exact complements on session mode. Only the non-interactive member also
 * declares `isHidden` (the interactive member relies on being disabled) —
 * the catalogue prover reads both fields; keep the asymmetry.
 */
export const context = {
  type: 'local-jsx',
  name: 'context',
  description: 'Chart the context window — a colored cell map of what fills it',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./context.js'),
} satisfies Command

export const contextNonInteractive = {
  type: 'local',
  name: 'context',
  description: 'Print the context-window breakdown',
  isEnabled: () => getIsNonInteractiveSession(),
  get isHidden(): boolean {
    return !getIsNonInteractiveSession()
  },
  supportsNonInteractive: true,
  load: () => import('./context-noninteractive.js'),
} satisfies Command
