import type { Command } from '../../commands.js'

const rewind = {
  // What the verb does (FN-015 rank 8): the session's own runner restores
  // its files to a saved point, winds its conversation back to that turn,
  // or both — the surface offers only what the session's facts allow.
  description: 'Wind back to a saved point — the files, the conversation, or both',
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  // Acts on the SCREEN: runs in the screen process against the focused chat.
  seat: 'screen',
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
