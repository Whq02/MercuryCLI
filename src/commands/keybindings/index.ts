import type { Command } from '../catalogue/commands.js'

const keybindings: Command = {
  name: 'keybindings',
  description: 'Edit your keybindings file (/keys shows the effective map)',
  supportsNonInteractive: false,
  seat: 'screen',
  type: 'local',
  load: () => import('./keybindings.js'),
}

export default keybindings
