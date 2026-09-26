import type { Command } from '../../commands.js'

const speak = {
  type: 'local',
  name: 'speak',
  description: 'Voice input on or off — with it on, holding space dictates into the composer; options chooses the transcriber, download fetches the on-device model',
  argumentHint: '[on|off|options|download]',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./speak.js'),
} satisfies Command

export default speak
