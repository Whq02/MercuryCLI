import type { Command } from '../../commands.js'

const status = {
  type: 'local',
  name: 'status',
  description:
    'The session dashboard — version, model, accounts, connectivity, tools',
  immediate: true,
  supportsNonInteractive: false,
  seat: 'screen',
  userPrivate: true,
  load: () =>
    import('./mercuryStatus.js'),
} satisfies Command

export default status
