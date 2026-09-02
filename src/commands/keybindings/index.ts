import type { Command } from '../../commands.js'

const keybindings = {
  name: 'keybindings',
  description: 'Edit your keybindings file (/keys shows the effective map)',
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  type: 'local',
  load: () => import('./keybindings.js'),
} satisfies Command

export default keybindings
