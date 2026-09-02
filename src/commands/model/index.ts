import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Set the model for Mercury (currently ${renderModelName(getMainLoopModel())})`
  },
  // A session pin (mainLoopModelForSession) wins over the stored setting —
  // the same order the API resolves.
  currentValue: live => renderModelName(live.mainLoopModelForSession ?? getMainLoopModel()),
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  // the dedicated MercuryModelPicker (real model list + switch + effort).
  // The base React-Compiler picker stays as the fallback and the `/model <arg>` path.
  load: () =>
    import('./mercuryModel.js'),
} satisfies Command
