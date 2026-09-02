/**
 * /copy descriptor: nothing but metadata plus a load() that fetches the
 * real implementation from copy.tsx on demand — boot stays light.
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    "Put Mercury's latest reply on the clipboard (/copy N reaches back)",
  load: () => import('./copy.js'),
} satisfies Command

export default copy
