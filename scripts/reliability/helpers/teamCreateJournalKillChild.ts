// FC1 child (post-fix) — the REAL journaled team-create, killed by a
// parent-set MERCURY_FAULT_INJECT at an exact journal boundary (e.g. after
// the team file landed, before the task epoch — the original FC1 window).
import { getSessionId } from '../../../src/bootstrap/state.ts'
import { performTeamCreateOperation } from '../../../src/utils/swarm/teamOperations.ts'

const teamName = process.env.RELIA_TEAM
if (!teamName) throw new Error('RELIA_TEAM required')
const now = Date.now()
await performTeamCreateOperation({
  teamName,
  teamFile: {
    name: teamName,
    createdAt: now,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: getSessionId(), // matches the op owner (as TeamCreateTool does)
    members: [
      {
        agentId: `team-lead@${teamName}`,
        name: 'team-lead',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: process.cwd(),
        subscriptions: [],
      },
    ],
  },
})
process.exit(0)
