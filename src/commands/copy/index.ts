import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    'Copy the last reply to the clipboard, whole (/copy 2 the one before, /copy code the last code block)',
  argumentHint: '[N | code]',
  load: () => import('./copy.js'),
} satisfies Command

export default copy
