import type { Command } from '../../commands.js'

// /harness — the operator contract: inspect the resolved
// harness profile (identity · origin · reason · axes · declined trail),
// pin for this session, persist a durable default, reset to the selector.
const command = {
  type: 'local-jsx',
  name: 'harness',
  description: 'Harness profile — inspect, pin, reset',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./harness.js'),
} satisfies Command

export default command
