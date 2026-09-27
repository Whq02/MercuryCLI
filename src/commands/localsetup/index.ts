import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'localsetup',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: 'Set up a local model: find or install Ollama, start it, pull qwen3.5:9b, set its window, pick it — each step asks before it runs',
  load: () => import('./localsetup.js'),
} satisfies Command
