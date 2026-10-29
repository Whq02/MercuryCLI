import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'usage',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: 'Show usage per provider — every family, honest absence included',
  load: () => import('./usage.js'),
} satisfies Command
