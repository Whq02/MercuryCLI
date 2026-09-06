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
  return true
}

const feedback = {
  type: 'local-jsx',
  name: 'feedback',
  aliases: ['bug'],
  description: 'Report a bug — a redacted report is shown, then filed through your GitHub CLI; without it a prefilled issue form opens in your browser and the local draft stays',
  argumentHint: '[report]',
  isEnabled: feedbackEnabled,
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
