import type { Command } from '../../commands.js'

const command = {
  name: 'bootmenu',
  description: 'Open Boot Settings — future-session defaults, in place (no splash replay)',
  supportsNonInteractive: false,
  seat: 'screen',
  type: 'local',
  load: () => import('./bootmenu.js'),
} satisfies Command

export default command
