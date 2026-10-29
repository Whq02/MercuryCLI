import type { Command } from '../../commands.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  description: 'Choose the AI model',
  currentValue: () => {
    const facts = focusedSessionModelFacts()
    return facts === null ? undefined : renderModelName(facts.effective)
  },
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () =>
    import('./mercuryModel.js'),
} satisfies Command
