import type { Command } from '../../commands.js'

// ============================================================================
// commands/branches — the side-lane board: every bounded
// lane this session parents or inhabits, with status + the next action
// (/branch return · /branch promote <id> · /branch drop <id>).
// ============================================================================

const branches = {
  type: 'local',
  name: 'branches',
  description: 'List bounded side lanes (goal · status · handoff) for this session',
  isEnabled: () => true,
  load: () => import('./branches.js'),
} as Command

export default branches
