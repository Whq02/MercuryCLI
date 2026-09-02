import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'caching',
  description: "Prompt caching — every family's truth, and the TTL dial where a provider offers one",
  load: () => import('./caching.js'),
} satisfies Command

export default command
