import type { Command } from '../../commands.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'

const command = {
  name: 'concourse',
  get description(): string {
    return chatOnlyBoot()
      ? 'Open the live view of your sessions — the concourse is off in this boot'
      : 'Open the Session Concourse — the multi-session home board, in place'
  },
  supportsNonInteractive: false,
  type: 'local',
  uiRouteAlias: 'concourse',
  load: () => import('./concourse.js'),
} satisfies Command

export default command
