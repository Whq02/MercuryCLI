import type { Command } from '../catalogue/commands.js'
import { workbenchEnabled } from '../../screen/workbench/contracts.js'


const workbenchCommand = {
  type: 'local-jsx',
  name: 'workbench',
  description: 'The prompts panel — the prompts you sent in this chat, the crew traffic, and your saved prompts',
  isEnabled: () => workbenchEnabled(),
  isHidden: false,
  load: () => import('./workbench.js'),
} satisfies Command

export default workbenchCommand
