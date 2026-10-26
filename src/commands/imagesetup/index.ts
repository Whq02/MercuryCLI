import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'imagesetup',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: 'Set up local images and video: install the runtime, pull models, choose defaults and generate a test image',
  load: () => import('./imagesetup.js'),
} satisfies Command
