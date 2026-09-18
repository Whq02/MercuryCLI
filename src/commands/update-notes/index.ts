import type { Command } from '../../commands.js'

const updateNotes = {
  description: "Read this release's notes; the earlier releases wait behind the transcript key",
  name: 'update-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./update-notes.js'),
} satisfies Command

export const releaseNotes = {
  ...updateNotes,
  name: 'release-notes',
  description: 'The former name of /update-notes; runs the same command',
  isHidden: true,
  canonicalRoute: 'update-notes',
} satisfies Command

export default updateNotes
