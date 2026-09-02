import type { Command } from '../../commands.js'

const command = {
  type: 'local',
  name: 'companion',
  description: 'Toggle the session companion — creature · moods · a word at the right moment · tips',
  argumentHint: '[on|off|tip]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./companion.js'),
} satisfies Command

export default command
