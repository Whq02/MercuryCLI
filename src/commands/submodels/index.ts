import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const command = {
  type: 'local-jsx',
  name: 'submodels',
  description: "The Advisor's model — the second model that advises the working model",
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./submodels.js'),
} satisfies Command

export default command
