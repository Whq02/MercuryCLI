import type { Command } from '../../commands.js'

const advise = {
  type: 'local',
  name: 'advise',
  description: 'The advisor for this chat — on, off, or the current state (a second model that writes the agent one note on a cadence)',
  argumentHint: '[on|off]',
  supportsNonInteractive: true,
  load: () => import('./advise.js'),
} satisfies Command

export default advise
