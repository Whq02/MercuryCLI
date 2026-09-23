import type { Command } from '../../commands.js'

const view = {
  type: 'local',
  name: 'view',
  description: 'Show or hide the SESSIONS bar along the bottom of the chat',
  argumentHint: '[on|off]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./view.js'),
} satisfies Command

export default view
