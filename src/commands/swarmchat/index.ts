import type { Command } from '../../commands.js'

const swarmchat = {
  type: 'local-jsx',
  name: 'swarmchat',
  description: 'Show board messages in the chat',
  argumentHint: '[all|team <name>|main]',
  headlessVerbs: ['', 'all', 'team', 'main'],
  load: () => import('./swarmchat.js'),
} satisfies Command

export default swarmchat
