import type { Command } from '../../commands.js'
import { EFFORT_LEVELS, getDisplayedEffortLabel, modelSupportsEffort } from '../../utils/effort.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: "Pick the model's reasoning effort for this session",
  // The SAME honest resolve the standing EffortChip renders (model default,
  // floors and clamps included) — the row can never disagree with the chip.
  currentValue: live => {
    const model = live.mainLoopModelForSession ?? getMainLoopModel()
    if (!modelSupportsEffort(model)) return undefined
    return getDisplayedEffortLabel(model, live.effortValue)
  },
  // The hint names the ladder the command accepts — derived, so a level the
  // ladder carries (xhigh) and the two modes can never drop out of it.
  argumentHint: `[${EFFORT_LEVELS.join('|')}|supercode|auto]`,
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
