import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'harness',
  description: 'Harness profile — inspect, pin, reset',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./harness.js'),
} satisfies Command

export default command
