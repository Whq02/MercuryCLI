import type { Command } from '../../commands.js'

const keybindings = {
  name: 'keybindings',
  description: 'Edit your keybindings file (/keys shows the effective map)',
  supportsNonInteractive: false,
  seat: 'screen',
  type: 'local',
  load: () => import('./keybindings.js'),
} satisfies Command

export default keybindings
