import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'crewmates',
  aliases: ['teammates'],
  needsConcourse: true,
  description: "Crew — the session's sub-agents live, and the named crewmates' chats",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./teammates.js'),
} satisfies Command

export default command
