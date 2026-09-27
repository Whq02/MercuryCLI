import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'localsetup',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: 'Set up a local model: find or install Ollama, start it, choose a model (on the server, or one it can pull that fits this machine), set its window, pick it — each step asks before it runs',
  load: () => import('./localsetup.js'),
} satisfies Command
