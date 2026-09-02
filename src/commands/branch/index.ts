import type { Command } from '../../commands.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  // The 'fork' spelling lands here unless a real /fork command is registered.
  aliases: ['fork'],
  description:
    'Branch the conversation — with a goal it becomes a bounded side lane (return/promote/drop verbs; see /branches)',
  argumentHint: '[goal | return <answer> | promote <laneId> | drop <laneId>]',
  load: () => import('./branch.js'),
} satisfies Command

export default branch
