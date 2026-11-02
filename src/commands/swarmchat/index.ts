import type { Command } from '../../commands.js'

const swarmchat = {
  type: 'local-jsx',
  name: 'swarmchat',
  description: 'Show board messages in the chat',
  argumentHint: '[on|off|all|team <name>|main]',
  headlessVerbs: ['', 'on', 'off', 'all', 'team', 'main'],
  load: () => import('./swarmchat.js'),
} satisfies Command

export default swarmchat
