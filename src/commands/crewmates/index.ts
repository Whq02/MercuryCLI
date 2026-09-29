import type { Command } from '../../commands.js'
import { RETIRED_CREWMATES_COMMAND_NAME } from '../../migrations/retiredCrewSpellings.js'

const command = {
  type: 'local-jsx',
  name: 'crewmates',
  aliases: [RETIRED_CREWMATES_COMMAND_NAME],
  needsConcourse: true,
  description: "Crew — the session's sub-agents live, and the named crewmates' chats",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../crewmates/crewmates.js'),
} satisfies Command

export default command
