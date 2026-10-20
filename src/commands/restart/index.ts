import type { Command } from '../../commands.js'

const command = {
  type: 'local',
  name: 'restart',
  description: 'Move this session onto the installed Mercury build (stops and resumes it)',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./restart.js'),
} satisfies Command

export default command
