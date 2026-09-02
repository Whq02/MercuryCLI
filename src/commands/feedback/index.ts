import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { Command } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

/** Enabled unless ANY disqualifier holds (env spellings are contract data). */
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
  // Says what happens on a DEFAULT box: the draft is a local file (the
  // browser GitHub-issue arm exists only under MERCURY_ISSUES_REPO_URL) —
  // the old line promised an issue that unconfigured boxes never produced
  // (TASK-017 S2, feedback-report-built-then-discarded).
  description: 'File a bug — a redacted report is drafted to a local file (nothing is uploaded)',
  argumentHint: '[report]',
  isEnabled: feedbackEnabled,
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
