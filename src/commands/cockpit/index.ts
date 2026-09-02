import type { Command } from '../../commands.js'

const cockpit = {
  type: 'local-jsx',
  immediate: true,
  name: 'cockpit',
  needsConcourse: true,
  isEnabled: () => true,
  aliases: ['deck'],
  description:
    'Open the Mercury cockpit — tab between deck · fleet · trace · substrate · policy in one view',
  argumentHint: '[deck|fleet|trace|substrate|policy]',
  load: () => import('./cockpit.js'),
} satisfies Command

export default cockpit
