import type { Command } from '../../types/command.js'

const lsp = {
  type: 'local',
  name: 'lsp',
  description: 'The language servers of this workspace · `status` lists each server and its state · `restart [<server>]` restarts one or all',
  argumentHint: 'status | restart [<server>]',
  supportsNonInteractive: false,
  load: () => import('./lsp.js'),
} satisfies Command

export default lsp
