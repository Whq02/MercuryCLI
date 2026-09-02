import type { Command } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'What this session has spent, and how long it has run',
  supportsNonInteractive: true,
  get isHidden(): boolean {
    return isClaudeAISubscriber()
  },
  load: () => import('./cost.js'),
} satisfies Command

export default cost
