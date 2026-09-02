import type { Command } from '../../commands.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'

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
