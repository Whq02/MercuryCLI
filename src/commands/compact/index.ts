import type { Command } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const compact = {
  type: 'local',
  name: 'compact',
  description: 'Compact the conversation — /compact [instructions for summarization]',
  argumentHint: '[instructions for summarization]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  load: () => import('./compact.js'),
} satisfies Command

export default compact
