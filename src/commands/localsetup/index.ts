import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'localsetup',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: 'Set up a local model from Hugging Face, the Bank, Ollama or a running server',
  load: () => import('./localsetup.js'),
} satisfies Command
