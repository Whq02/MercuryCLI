import type { Command } from '../../commands.js'

const title = {
  type: 'local-jsx',
  name: 'title',
  description: "Title the focused session (no words: the model writes one)",
  immediate: true,
  argumentHint: '[words]',
  load: () => import('./title.js'),
} satisfies Command

export default title
