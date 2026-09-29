import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'crewmates',
  needsConcourse: true,
  description: "Crew — the session's sub-agents live, and the named crewmates' chats",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../crewmates/crewmates.js'),
} satisfies Command

export default command
