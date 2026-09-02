import type { Command } from '../../commands.js'

const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: 'Browse the skills this session can load',
  load: () => import('./skills.js'),
} satisfies Command

export default skills
