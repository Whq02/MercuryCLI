import type { Command } from '../../commands.js'

const contract = {
  type: 'local-jsx',
  name: 'contract',
  description: "Show the focused session's contract; with words, draft or amend it ('close' closes)",
  immediate: true,
  argumentHint: '[words | close]',
  load: () => import('./contract.js'),
} satisfies Command

export default contract
