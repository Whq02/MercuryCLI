import type { Command } from '../../commands.js'

const config = {
  aliases: ['settings'],
  type: 'local',
  name: 'config',
  description: 'Open the config panel',
  supportsNonInteractive: false,
  seat: 'screen',
  userPrivate: true,
  load: () => import('./config.js'),
} satisfies Command

export default config
