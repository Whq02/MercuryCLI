import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const command = {
  type: 'local-jsx',
  name: 'submodels',
  description: 'Sub-model containers — the Minerva and Console models',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./submodels.js'),
} satisfies Command

export default command
