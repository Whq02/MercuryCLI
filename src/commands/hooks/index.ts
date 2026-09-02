import type { Command } from '../../commands.js'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: "Inspect the hooks wired to this session's tool events",
  immediate: true,
  load: () => import('./hooks.js'),
} satisfies Command

export default hooks
