import type { Command } from '../../commands.js'
import { advisorChipWords } from '../../services/advisor/advisorSettings.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'

const advise = {
  type: 'local',
  name: 'advise',
  description: 'The advisor for this chat — on, off, or the current state (a second model that writes the agent one note on a cadence)',
  argumentHint: '[on|off]',
  supportsNonInteractive: true,
  currentValue: () => {
    if (!hasFocusedSession()) return undefined
    const facts = getFocusedSessionConnector().advisorFacts()
    if (facts === null) return undefined
    return advisorChipWords(facts)?.replace(/^advisor · /, '') ?? 'off'
  },
  load: () => import('./advise.js'),
} satisfies Command

export default advise
