import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'jev',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: "JEV — official or OpenRouter, each road's key, spend and allowance; the switch, pace and truthful status",
  argumentHint: '[on | off | or on | or off]',
  load: () => import('./jev.js'),
} satisfies Command
