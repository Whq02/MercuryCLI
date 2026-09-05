import type { Command } from '../../commands.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { EFFORT_LEVELS, modelSupportsEffort, parseEffortValue, resolveStampedEffortTruth } from '../../utils/effort.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: "Pick the model's reasoning effort for this session",
  currentValue: () => {
    const facts = focusedSessionModelFacts()
    if (facts === null || facts.effort === null || facts.effort === undefined) return undefined
    if (!modelSupportsEffort(facts.effective)) return undefined
    if (facts.effortSent !== undefined && facts.effortSent !== null) return facts.effortSent
    if (facts.effortSent === undefined) return `${facts.effort} (asked)`
    return resolveStampedEffortTruth(facts.effective, parseEffortValue(facts.effort)).label
  },
  argumentHint: `[${EFFORT_LEVELS.join('|')}|supercode|auto]`,
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
