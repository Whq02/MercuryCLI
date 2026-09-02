import type { Command } from '../../commands.js'

// /capabilities — mounts the Mercury CapabilityManagerView (design-system surface) in place of the base surface.
const command = {
  type: 'local-jsx',
  name: 'capabilities',
  description: "Capability manager",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./capabilities.js'),
} satisfies Command

export default command
