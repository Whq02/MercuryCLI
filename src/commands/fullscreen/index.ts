import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'fullscreen',
  description: "Fullscreen command center (Mercury Terminal harness)",
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./fullscreen.js'),
} satisfies Command

export default command
