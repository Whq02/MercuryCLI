import type { Command } from '../../commands.js'

// /realms — the realms launcher, LIVE.
// Bare form mounts the panel; arg forms write the registry:
// add <path> [acct] · revoke <name> · account <name> <acct> · clone <src> [path] [acct].
const command = {
  type: 'local-jsx',
  name: 'realms',
  description: 'Realms launcher — trusted project folders w/ per-realm launch accounts; `/realms add <path>` trusts, `/realms clone <repo>` clones, bare opens the panel',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./realms.js'),
} satisfies Command

export default command
