import type { Command } from '../../commands.js'

const command = {
  type: 'local-jsx',
  name: 'crewmates',
  needsConcourse: true,
  description: "Crew — the session's crewmates live; on or off flips whether this session may spawn them",
  argumentHint: '[on|off]',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../crewmates/crewmates.js'),
} satisfies Command

export default command
