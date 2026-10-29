import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: 'Open the Agent Studio — build, edit, and tune your agents',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./agents.js'),
} satisfies Command

export default agents
