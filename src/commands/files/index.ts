import type { Command } from '../../commands.js'

const files = {
  type: 'local',
  name: 'files',
  description: 'Browse the working folder and put a file path in the composer',
  isHidden: true,
  supportsNonInteractive: false,
  seat: 'screen',
  userPrivate: true,
  load: () => import('./files.js'),
} satisfies Command

export default files
