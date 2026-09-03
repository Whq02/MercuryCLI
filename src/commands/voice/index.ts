import type { Command } from '../../commands.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'Start or stop a voice capture into the composer (the same as pressing space)',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./voice.js'),
} satisfies Command

export default voice
