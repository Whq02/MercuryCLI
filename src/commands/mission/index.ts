import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// ============================================================================
// commands/mission/index.ts — the /mission standing-mission command.
// ----------------------------------------------------------------------------
// Two descriptors, split by session kind (the same interactive/-p split other
// dual-surface commands in the tree use):
//   - mission (local-jsx)            — interactive; the default export.
//   - missionNonInteractive (local)  — for -p/SDK sessions.
// Exactly one is enabled per session; the non-interactive twin also hides
// itself from listings outside -p so the pair never shows up twice.
// The one name is /mission.
// ============================================================================

export const mission: Command = {
  type: 'local-jsx',
  name: 'mission',
  description: 'Set a mission — keep working until the condition is met',
  argumentHint: '[<condition> | clear|cancel]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./mission-jsx.js'),
}

export const missionNonInteractive: Command = {
  type: 'local',
  name: 'mission',
  supportsNonInteractive: true,
  description: 'Set a mission — keep working until the condition is met',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () => import('./mission.js'),
}

export default mission
