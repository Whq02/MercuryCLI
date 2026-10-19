import type { Command } from '../../commands.js'
import { LLM_HOST_WORDS } from './words.js'

export default {
  type: 'local',
  name: 'llmhost',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: LLM_HOST_WORDS.description,
  load: () => import('./llmhost.js'),
} satisfies Command
