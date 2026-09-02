import type { Command } from '../../commands.js'
import { routerEnabled } from '../../utils/router/routerGates.js'


export const routerCommand = {
  type: 'local-jsx',
  name: 'router',
  description:
    'Route fabric — plans, postures, pins, engines, why the last decision happened; /router key <provider> connects an API key (masked entry)',
  argumentHint: '[adaptive|quality|balanced|fast|fixed | pin opus|sonnet|auto | explain | engines | source sub|api|clear | key [provider] [clear] | reset-history]',
  isEnabled: () => routerEnabled(),
  isHidden: false,
  load: () => import('./router.js'),
} satisfies Command

export default routerCommand
