import type { Command } from '../../commands.js'

const supervisor = {
  type: 'local',
  name: 'supervisor',
  description: 'Toggle the run-completion supervisor — evidence-checked stops for long runs (off by default)',
  argumentHint: '[on|off]',
  supportsNonInteractive: true,
  load: () => import('./supervisor.js'),
} satisfies Command

export default supervisor
