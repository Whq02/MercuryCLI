import type { Command } from '../../commands.js'

// /palette — the fuzzy command palette: a nucleo-style fuzzy search over the
// live command roster (src/utils/fuzzyMatch.ts) with the derived command ladder
// header (src/utils/commandHierarchy.ts). The consumer that finally wires the
// two leaves Mercury carried but never used.
const palette = {
  type: 'local-jsx',
  name: 'palette',
  description:
    'Fuzzy command palette — nucleo-style search over the live command roster + the command ladder',
  aliases: ['p'],
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./palette.js'),
} satisfies Command

export default palette
