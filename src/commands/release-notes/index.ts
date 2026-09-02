import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: 'Read the bundled changelog, newest release first',
  name: 'release-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./release-notes.js'),
}

export default releaseNotes
