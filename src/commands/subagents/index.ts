import type { Command } from '../../commands.js'

const subagents = {
  type: 'local',
  name: 'subagents',
  description: "Sub-agents for this session — on, off, or the current switch (the Agent tool and every spawn road)",
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => import('./subagents.js'),
} satisfies Command

export default subagents
