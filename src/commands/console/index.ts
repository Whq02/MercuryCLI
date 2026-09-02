import type { Command } from '../../commands.js'
import { consoleEnabled } from '../../utils/cockpit/helmConsole.js'

// /console — the Helm console's full surface: session Q/A history + the
// selected answer rendered as real Markdown (the cockpit rail shows a
// plain-text glance; this is the read view). With an argument it ASKS —
// the same store + side-question fork the rail's ↵ uses, so the two
// surfaces can never disagree. Fork-registered; MERCURY_HELM_CONSOLE=0 kills.
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
