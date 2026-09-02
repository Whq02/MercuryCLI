import type { Command } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'What this session has spent, and how long it has run',
  supportsNonInteractive: true,
  // Subscribers pay per subscription, not per token — the command stays
  // callable but is not advertised. Evaluated live: /logins can change it.
  get isHidden(): boolean {
    return isClaudeAISubscriber()
  },
  load: () => import('./cost.js'),
} satisfies Command

export default cost
