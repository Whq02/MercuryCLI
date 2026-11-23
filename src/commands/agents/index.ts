import type { Command } from '../catalogue/commands.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'

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
