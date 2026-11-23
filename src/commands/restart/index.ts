import type { Command } from '../catalogue/commands.js'

const command = {
  type: 'local',
  name: 'restart',
  description: 'Restart this chat on the installed build; background jobs stop',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./restart.js'),
} satisfies Command

export default command
