import type { Command } from '../../commands.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

const feedback: Command = {
  type: 'local-jsx',
  name: 'feedback',
  aliases: ['bug'],
  description:
    'Report a bug — a redacted report is shown, then filed through your GitHub CLI; without it a prefilled issue form opens in your browser and the local draft stays',
  argumentHint: '[report]',
  isEnabled: () => {
    if (!flagEnabled('MERCURY_FEEDBACK_COMMAND')) return false
    if (!flagEnabled('MERCURY_BUG_COMMAND')) return false
    return !isEssentialTrafficOnly()
  },
  load: () => import('./feedback.js'),
}

export default feedback
