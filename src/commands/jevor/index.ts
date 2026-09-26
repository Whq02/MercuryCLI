import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'jevor',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: 'JEV through OpenRouter — its own spend and allowance, using the existing OpenRouter sign-in',
  argumentHint: 'on | off',
  load: () => import('./jevor.js'),
} satisfies Command
