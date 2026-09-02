import type { Command } from '../../commands.js'

const accent = {
  type: 'local',
  name: 'accent',
  description: 'Colour the REPL — override the identity accent (name, #hex, or reset)',
  argumentHint: '[name|#hex|reset]',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./accent.js'),
} satisfies Command

export default accent
