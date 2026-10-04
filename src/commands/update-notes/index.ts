import type { Command } from '../../commands.js'

const updateNotes = {
  description: "Read this release's notes; the earlier releases wait behind the transcript key",
  name: 'update-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./update-notes.js'),
} satisfies Command

export default updateNotes
