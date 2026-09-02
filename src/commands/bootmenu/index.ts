import type { Command } from '../../commands.js'

const command = {
  name: 'bootmenu',
  description: 'Open Boot Settings — future-session defaults, in place (no splash replay)',
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  type: 'local',
  load: () => import('./bootmenu.js'),
} satisfies Command

export default command
