import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import type { Command } from '../../types/command.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

function feedbackEnabled(): boolean {
  if (
    !flagEnabled('MERCURY_FEEDBACK_COMMAND') ||
    !flagEnabled('MERCURY_BUG_COMMAND')
  ) {
    return false
  }
  if (isEssentialTrafficOnly()) return false
  if (!isPolicyAllowed('allow_product_feedback')) return false
  return true
}

const feedback = {
  type: 'local-jsx',
  name: 'feedback',
  aliases: ['bug'],
  description: 'Report a bug — a redacted report is shown, then filed through your GitHub CLI (a local draft without it)',
  argumentHint: '[report]',
  isEnabled: feedbackEnabled,
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
