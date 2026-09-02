import type { Command } from '../../commands.js'


const debriefCommand: Command = {
  type: 'local',
  name: 'debrief',
  description: 'Generate a one-line session debrief now',
  supportsNonInteractive: false,
  load: () => import('./debrief.js'),
}

export default debriefCommand
