import type { Command } from '../../types/command.js'

/**
 * /extensions — install extensions and manage their sources. The board:
 * two sections (installed · sources) on the panes chassis; deep links ride
 * the argument and `/extensions reload` swaps the running session without
 * opening it. Headless sessions use `mercury extensions …` instead.
 */
const command = {
  type: 'local-jsx',
  name: 'extensions',
  description: 'install extensions and manage their sources',
  whenToUse: 'add a source, install an extension or skill pack, approve, update, uninstall',
  argumentHint: '[sources | reload | <name> | add <url|path> | install <name>[@label]]',
  load: () => import('./extensions.js'),
} satisfies Command

export default command
