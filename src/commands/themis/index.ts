import type { Command } from '../../commands.js'
import { themisActive } from '../../substrate/themis/level.js'


export const themis: Command = {
  type: 'local',
  name: 'themis',
  description: 'Track a bounded change mission: criteria, expected paths, drift warnings, evidence-gated completion (THEMIS)',
  argumentHint: '[start <title> | crit <text> :: <paths> :: <checks> | add <path> | inspected <path> | done | drop <why>]',
  isEnabled: () => themisActive(),
  supportsNonInteractive: true,
  load: () => import('./themis.js'),
}

export default themis
