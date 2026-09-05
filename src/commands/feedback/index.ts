import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { Command } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

function feedbackEnabled(): boolean {
  if (
    isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
    isEnvTruthy(process.env.DISABLE_BUG_COMMAND)
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
