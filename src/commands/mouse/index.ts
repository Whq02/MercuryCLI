import type { Command } from '../../commands.js'

const mouse = {
  type: 'local',
  name: 'mouse',
  description: 'Toggle mouse capture — off = native terminal select/copy, on = clickable TUI',
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./mouse.js'),
} satisfies Command

export default mouse
