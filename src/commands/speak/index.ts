import type { Command } from '../../commands.js'

const speak = {
  type: 'local',
  name: 'speak',
  description: 'Voice input on or off — with it on, space in an empty composer dictates into it',
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./speak.js'),
} satisfies Command

export default speak
