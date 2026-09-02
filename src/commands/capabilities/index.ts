import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'capabilities',
  description: "Capability manager",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./capabilities.js'),
} satisfies Command

export default command
