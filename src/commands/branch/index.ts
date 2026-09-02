import type { Command } from '../../commands.js'

const branch = {
  type: 'local-jsx',
  name: 'branch',
  aliases: ['fork'],
  description:
    'Branch the conversation — with a goal it becomes a bounded side lane (return/promote/drop verbs; see /branches)',
  argumentHint: '[goal | return <answer> | promote <laneId> | drop <laneId>]',
  load: () => import('./branch.js'),
} satisfies Command

export default branch
