import type { Command } from '../../commands.js'

const rewind = {
  description: 'Wind back to a saved point — the files, the conversation, or both',
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
