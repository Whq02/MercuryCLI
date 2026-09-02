import type { Command } from '../../commands.js'

const halt = {
  type: 'local',
  name: 'halt',
  isEnabled: () => true,
  description: 'Hard stop — kill all running daemons + subagents (the manual break)',
  supportsNonInteractive: true,
  seat: 'screen',
  interruptFirst: true,
  load: () => import('./halt.js'),
} satisfies Command

export default halt
