import type { Command } from '../../commands.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'Voice input on or off — with it on, holding space dictates into the composer; bare /voice starts or stops one capture, options chooses the transcriber, download fetches the on-device model',
  argumentHint: '[on|off|capture|options|download]',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./voice.js'),
} satisfies Command

export default voice
