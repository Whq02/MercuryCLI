import type { Command } from '../../commands.js'

// /teammates — mounts the Crew view (the session's sub-agents + the named agents' chats).
const command = {
  type: 'local-jsx',
  name: 'teammates',
  needsConcourse: true,
  description: "Crew — the session's sub-agents live, and the named agents' chats",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./teammates.js'),
} satisfies Command

export default command
