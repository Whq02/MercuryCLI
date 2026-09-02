import type { Command } from '../../commands.js'

const command = {
  name: 'vim',
  description: 'Flip the input line between Vim and standard editing',
  supportsNonInteractive: false,
  seat: 'screen',
  type: 'local',
  load: () => import('./vim.js'),
} satisfies Command

export default command
