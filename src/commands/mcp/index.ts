import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Browse server tools and parameters; reconnect, enable or disable',
  immediate: true,
  argumentHint: '[enable|disable|reconnect [server-name]]',
  load: () => import('./mcp.js'),
} satisfies Command

export default mcp
