import type { Command } from '../../commands.js'

const pings = {
  type: 'local',
  name: 'pings',
  description: 'Toggle the pings bell — one terminal-bell tap when a session needs you or finishes a run (the rows stay)',
  argumentHint: '[on|off]',
  supportsNonInteractive: true,
  load: () => import('./pings.js'),
} satisfies Command

export default pings
