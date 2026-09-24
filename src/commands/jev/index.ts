import type { Command } from '../../commands.js'

export default {
  type: 'local',
  name: 'jev',
  seat: 'screen',
  userPrivate: true,
  supportsNonInteractive: false,
  description: "JEV — the one switch, the key, this session's spend, the allowance, the pace, the request ceiling and the truthful status",
  load: () => import('./jev.js'),
} satisfies Command
