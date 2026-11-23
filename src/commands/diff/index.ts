import type { Command } from '../catalogue/commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description: 'Review workspace over uncommitted + per-turn changes (sources · files · hunks)',
  load: () => import('./diff.js'),
} satisfies Command
