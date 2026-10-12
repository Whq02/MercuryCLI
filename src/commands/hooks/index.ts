import type { Command } from '../../commands.js'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: "Inspect the hooks wired to this session's events — turns, tools, permissions, crewmates, compaction, sessions and files",
  immediate: true,
  load: () => import('./hooks.js'),
} satisfies Command

export default hooks
