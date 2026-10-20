import type { Command } from '../../commands.js'

const command = {
  type: 'local',
  name: 'restart',
  description: 'Stop and resume this session on the installed build',
  supportsNonInteractive: true,
  isHidden: true,
  load: () => import('./restart.js'),
} satisfies Command

export default command
