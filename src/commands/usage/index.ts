import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show usage per provider — every family, honest absence included',
  // Ungated: the surface enumerates EVERY provider
  // with honest absent rows and /logins routes, so a credential-less home
  // opens the same board — the old any-credential gate refused exactly the
  // operator the absence rows exist to guide.
  load: () => import('./usage.js'),
} satisfies Command
