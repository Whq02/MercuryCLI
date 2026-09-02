// FC1 recovery child — the teams-domain journal recovery pass (what the
// boot recovery orchestrator runs), printed as JSON.
import { recoverTeamJournal } from '../../../src/utils/swarm/teamOperations.ts'

const summary = await recoverTeamJournal()
console.log(JSON.stringify(summary))
process.exit(0)
