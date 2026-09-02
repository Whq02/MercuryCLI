import type { Command } from '../../commands.js'

const command = {
  name: 'vim',
  description: 'Flip the input line between Vim and standard editing',
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  type: 'local',
  load: () => import('./vim.js'),
} satisfies Command

export default command
