import type { Command } from '../../commands.js'

// /home — the Mercury startup splash (the full-home design), on demand.
// Mercury-only identity chrome, so stamp-gated like /substrate · /trace: bare-stamp
// (unconditional) ⇒
// byte-identical without the stamp.
const home = {
  type: 'local-jsx',
  name: 'home',
  description: 'Show the Mercury home splash — sigil, identity, realm & fleet glance',
  isEnabled: () => true,
  load: () => import('./home.js'),
} satisfies Command

export default home
