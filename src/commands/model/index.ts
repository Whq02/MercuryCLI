import type { Command } from '../catalogue/commands.js'
import { focusedSessionModelFacts } from '../../engine/connector/focusedConnector.js'
import { shouldInferenceConfigCommandBeImmediate } from '../catalogue/immediateCommand.js'
import { renderModelName } from '../../models/catalogue/engineModel.js'

const model: Command = {
  type: 'local-jsx',
  name: 'model',
  aliases: ['models'],
  description: 'Choose the AI model',
  currentValue: () => {
    const facts = focusedSessionModelFacts()
    return facts === null ? undefined : renderModelName(facts.effective)
  },
  argumentHint: '[model]',
  scope: 'agent',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./mercuryModel.js'),
}

export default model
