import type { Command } from '../../commands.js'


export const kill = {
  type: 'local',
  name: 'kill',
  description: 'Disable a tool/capability for this session (kill-switch); no arg lists current kills',
  argumentHint: '[<tool> | <agent>:<tool>]',
  isEnabled: () => true,
  load: () => import('./kill.js'),
} as Command

export const unkill = {
  type: 'local',
  name: 'unkill',
  description: 'Re-enable a tool/capability previously killed this session',
  argumentHint: '<tool> | <agent>:<tool>',
  isEnabled: () => true,
  load: () => import('./unkill.js'),
} as Command

export default kill
