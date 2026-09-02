import type { Command } from '../../commands.js'
import { workbenchEnabled } from '../../services/workbench/contracts.js'


export const workbenchCommand = {
  type: 'local-jsx',
  name: 'workbench',
  description: 'The prompts panel — the prompts you sent in this chat, the crew traffic, and your saved prompts',
  isEnabled: () => workbenchEnabled(),
  isHidden: false,
  load: () => import('./workbench.js'),
} satisfies Command

export default workbenchCommand
