import type { Command } from '../catalogue/commands.js'

const clear: Command = {
  type: 'local',
  name: 'clear',
  aliases: ['reset', 'new'],
  description: 'Start fresh — drop this conversation and reclaim its context',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./clear.js'),
}

export default clear
