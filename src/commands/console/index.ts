import type { Command } from '../../commands.js'
import { consoleEnabled } from '../../utils/cockpit/helmConsole.js'

const command = {
  type: 'local-jsx',
  name: 'console',
  description:
    'Helm console — side questions from the cockpit (history + full answers)',
  argumentHint: '[question | clear]',
  isEnabled: () => consoleEnabled(),
  isHidden: false,
  load: () => import('./console.js'),
} satisfies Command

export default command
