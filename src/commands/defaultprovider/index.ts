import type { Command } from '../../commands.js'

// /defaultprovider — the default account slot (usage-breadth law): the
// provider a fresh unpinned session starts on. The FIRST login records it;
// this command shows it and switches it, persisted in config (set, never
// heal-repainted — the two writers are the first-login seam and this
// command).
const defaultprovider = {
  type: 'local-jsx',
  name: 'defaultprovider',
  description: 'Show or switch the default provider — the lane fresh sessions start on',
  isEnabled: () => true,
  argumentHint: '[provider]',
  load: () => import('./defaultprovider.js'),
} satisfies Command

export default defaultprovider
