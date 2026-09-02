import type { Command } from '../../commands.js'


const branches = {
  type: 'local',
  name: 'branches',
  description: 'List bounded side lanes (goal · status · handoff) for this session',
  isEnabled: () => true,
  load: () => import('./branches.js'),
} as Command

export default branches
