import type { Command } from '../../commands.js'

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
