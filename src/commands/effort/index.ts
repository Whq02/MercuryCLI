import type { Command } from '../../commands.js'
import { EFFORT_LEVELS, getDisplayedEffortLabel, modelSupportsEffort } from '../../utils/effort.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: "Pick the model's reasoning effort for this session",
  currentValue: live => {
    const model = live.mainLoopModelForSession ?? getMainLoopModel()
    if (!modelSupportsEffort(model)) return undefined
    return getDisplayedEffortLabel(model, live.effortValue)
  },
  argumentHint: `[${EFFORT_LEVELS.join('|')}|supercode|auto]`,
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
