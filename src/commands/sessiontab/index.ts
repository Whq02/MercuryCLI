import type { Command } from '../../commands.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'

// Hidden chord-target for Option/Alt+←/→ on an empty prompt (also runnable as
// /sessiontab): flip to the most-recent other session in-place. Mercury-only;
// disabled in bare-stamp builds.
const sessiontab = {
  type: 'local-jsx',
  immediate: true,
  name: 'sessiontab',
  description: `Flip to your most-recent other session in-place (${keyHintLabel('⌥←/→')} on empty prompt)`,
  isHidden: true,
  isEnabled: () => true,
  load: () => import('./sessiontab.js'),
} satisfies Command
export default sessiontab
