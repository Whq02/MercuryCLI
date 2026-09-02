import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'MCP servers — status, tools, and per-server enable/disable',
  immediate: true,
  argumentHint: '[enable|disable [server-name]]',
  load: () => import('./mcp.js'),
} satisfies Command

export default mcp
