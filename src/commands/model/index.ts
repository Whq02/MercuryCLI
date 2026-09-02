import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Set the model for Mercury (currently ${renderModelName(getMainLoopModel())})`
  },
  currentValue: live => renderModelName(live.mainLoopModelForSession ?? getMainLoopModel()),
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () =>
    import('./mercuryModel.js'),
} satisfies Command
