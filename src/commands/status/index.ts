import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    'The session dashboard — version, model, accounts, connectivity, tools',
  immediate: true,
  load: () =>
    import('./mercuryStatus.js'),
} satisfies Command

export default status
