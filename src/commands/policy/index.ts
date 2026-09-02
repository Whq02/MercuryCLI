import type { Command } from '../../commands.js'

const policy = {
  type: 'local-jsx',
  immediate: true,
  name: 'policy',
  isEnabled: () => true,
  description: 'Mercury governance posture — mode, MCP risk, kill switches, denials',
  load: () => import('./policy.js'),
} satisfies Command

export default policy
