import type { Command } from '../../commands.js'

// /surfaces — the effective-catalogue surface index (the index
// lists surfaces, so it is named for them; the old name stays an alias): a
// category-grouped, arrow-navigable index of every normally discoverable
// surface, projected live from the ONE command registry; ↵ opens the surface
// for real. Toggle from anywhere with the ctrl+x m chord (command:surfaces).
const manager = {
  type: 'local-jsx',
  immediate: true,
  name: 'surfaces',
  aliases: ['manager'],
  isEnabled: () => true,
  description: 'Surface index — arrow-navigate every discoverable surface, grouped; ↵ opens it',
  load: () => import('./manager.js'),
} satisfies Command

export default manager
