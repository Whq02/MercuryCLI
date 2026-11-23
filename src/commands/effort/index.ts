import type { Command } from '../catalogue/commands.js'
import { focusedSessionModelFacts } from '../../engine/connector/focusedConnector.js'
import { EFFORT_LEVELS, modelSupportsEffort, parseEffortValue, resolveStampedEffortTruth } from '../../models/effort/effort.js'
import { shouldInferenceConfigCommandBeImmediate } from '../catalogue/immediateCommand.js'

const effort: Command = {
  type: 'local-jsx',
  name: 'effort',
  description: "Pick the model's reasoning effort — applies now and is saved as your default for new sessions",
  currentValue: () => {
    const facts = focusedSessionModelFacts()
    if (facts === null || facts.effort === undefined || facts.effort === null) return undefined
    if (!modelSupportsEffort(facts.effective)) return undefined
    if (facts.effortSent !== undefined && facts.effortSent !== null) return facts.effortSent
    if (facts.effortSent === undefined) return `${facts.effort} (asked)`
    return resolveStampedEffortTruth(facts.effective, parseEffortValue(facts.effort)).label
  },
  argumentHint: `[${EFFORT_LEVELS.join('|')}|auto]`,
  scope: 'agent',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
}

export default effort
