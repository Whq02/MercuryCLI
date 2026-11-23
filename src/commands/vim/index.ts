import type { Command } from '../catalogue/commands.js'

const command: Command = {
  name: 'vim',
  description: 'Flip the input line between Vim and standard editing',
  supportsNonInteractive: false,
  seat: 'screen',
  type: 'local',
  load: () => import('./vim.js'),
}

export default command
