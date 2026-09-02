import type { Command } from '../../commands.js'


const counsel = {
  type: 'local',
  name: 'counsel',
  description:
    'Run a bounded second look over the observed changes since the last review (opt-in: MERCURY_COUNSEL=manual|auto)',
  argumentHint: '[run]',
  isEnabled: () => true,
  load: () => import('./counsel.js'),
} as Command

export default counsel
