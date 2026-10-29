import type { Command } from '../../commands.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'On-device voice input — on downloads the speech model once; off disables dictation; while on, hold space or use bare /voice to start or stop a capture',
  argumentHint: '[on|off|capture]',
  supportsNonInteractive: false,

  seat: 'screen',
  load: () => import('./voice.js'),
} satisfies Command

export default voice
