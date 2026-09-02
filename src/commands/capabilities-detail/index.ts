import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'capabilities-detail',
  description: 'Capability inspector — MCP / skills / extensions detail (honest read)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./capabilities-detail.js'),
} satisfies Command

export default command
