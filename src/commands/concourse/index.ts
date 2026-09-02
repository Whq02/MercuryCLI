import type { Command } from '../../commands.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'

const command = {
  name: 'concourse',
  // The one explicit door in every world: the board in the fleet world; in
  // THE PLAIN WORLD (a `--chat` boot, the concourse switched off) the plain
  // live view of the sessions — the description says which, read live.
  get description(): string {
    return chatOnlyBoot()
      ? 'Open the live view of your sessions — the concourse is off in this boot'
      : 'Open the Session Concourse — the multi-session home board, in place'
  },
  supportsNonInteractive: false,
  type: 'local',
  // R1b: interactive submissions route IMMEDIATELY at the
  // composer boundary — no transcript row, no history entry, no Rewind
  // material. The load() body remains for non-interactive contexts only.
  uiRouteAlias: 'concourse',
  load: () => import('./concourse.js'),
} satisfies Command

export default command
