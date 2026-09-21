import type { Command } from '../../commands.js'

const files = {
  type: 'local',
  name: 'files',
  description: 'browse',
  isHidden: true,
  supportsNonInteractive: false,
  seat: 'screen',
  userPrivate: true,
  load: () => import('./files.js'),
} satisfies Command

export default files
