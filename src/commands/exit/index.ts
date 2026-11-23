import type { Command } from '../../commands.js'

const exit: Command = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: 'Close Mercury and hand the terminal back',
  immediate: true,
  load: () => import('./exit.js'),
}

export default exit
