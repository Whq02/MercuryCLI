import type { Command } from '../catalogue/commands.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'

const compact: Command = {
  type: 'local',
  name: 'compact',
  description: 'Compact the conversation — /compact [instructions for summarization]',
  argumentHint: '[instructions for summarization]',
  isEnabled: () => flagEnabled('MERCURY_COMPACT'),
  supportsNonInteractive: true,
  scope: 'agent',
  load: () => import('./compact.js'),
}

export default compact
