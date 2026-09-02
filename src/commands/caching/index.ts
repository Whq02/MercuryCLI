import type { Command } from '../../commands.js'

// /caching — every provider family's prompt-caching truth side by side
// (operator-ruled): a dial only where a vendor offers one — a
// dialed row writes the MERCURY_CACHE_TTL command-owned setting row
// (startupMenu's COMMAND_SETTINGS_ROWS; the boot-env applier applies it at
// boot); families with automatic caching carry their vendors' truths;
// families recording no mechanism say so honestly. The registration row is
// provider-neutral: the command is Mercury's surface, the vendors are data
// inside it.
const command = {
  type: 'local-jsx',
  name: 'caching',
  description: "Prompt caching — every family's truth, and the TTL dial where a provider offers one",
  load: () => import('./caching.js'),
} satisfies Command

export default command
