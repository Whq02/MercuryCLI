import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

// /submodels — the two SUB-model containers (Minerva · Console), each
// offering the full provider catalogue with truthful per-family signed-in
// state; a signed-out pick routes to its attach home and lands on return.
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
