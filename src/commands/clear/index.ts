import type { Command } from '../../types/command.js'

const clear = {
  type: 'local',
  name: 'clear',
  aliases: ['reset', 'new'],
  description: 'Start fresh — drop this conversation and reclaim its context',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./clear.js'),
} satisfies Command

export default clear
