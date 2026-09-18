import type { Command } from '../../commands.js'
import { isTabulaEnabled } from '../../utils/tabula/tabulaGates.js'


export const noteCommand = {
  type: 'local',
  name: 'note',
  description: 'Capture a note into the project notepad file (kept on disk under the Mercury config home)',
  argumentHint: '<a note to keep, or something to do later>',
  isEnabled: () => isTabulaEnabled(),
  isHidden: false,
  supportsNonInteractive: false,
  userPrivate: true,
  load: () => import('./note.js'),
} satisfies Command
