import type { Command } from '../../commands.js'

// /teammates — mounts the Mercury TeammateChatsView (design-system surface) in place of the base surface.
const command = {
  type: 'local-jsx',
  name: 'teammates',
  needsConcourse: true,
  description: "Teammate chats — named long-lived crew workers",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./teammates.js'),
} satisfies Command

export default command
