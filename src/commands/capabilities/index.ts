import type { Command } from '../catalogue/commands.js'

const command = {
  type: 'local-jsx',
  name: 'capabilities',
  description: "Capability manager",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./capabilities.js'),
} satisfies Command

export default command
