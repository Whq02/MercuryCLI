import type { Command } from '../../types/command.js'

const clear = {
  type: 'local',
  name: 'clear',
  aliases: ['reset', 'new'],
  description: 'Start fresh — drop this conversation and reclaim its context',
  // Under -p the right action is a new session, not a clear.
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  load: () => import('./clear.js'),
} satisfies Command

export default clear
