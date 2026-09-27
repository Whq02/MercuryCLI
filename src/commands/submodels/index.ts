import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const command = {
  type: 'local-jsx',
  name: 'submodels',
  description: "The Console's and the Advisor's models — the sub-models for side questions and for advising the working model",
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./submodels.js'),
} satisfies Command

export default command
