import type { Command } from '../../types/command.js'

const command = {
  type: 'local-jsx',
  name: 'extensions',
  description: 'install extensions and manage their sources',
  whenToUse: 'add a source, install an extension or skill pack, approve, update, uninstall',
  argumentHint: '[sources | reload | <name> | add <url|path> | install <name>[@label]]',
  load: () => import('./extensions.js'),
} satisfies Command

export default command
