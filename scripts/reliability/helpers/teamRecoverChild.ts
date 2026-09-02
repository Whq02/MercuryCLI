import { recoverTeamJournal } from '../../../src/utils/swarm/teamOperations.ts'

const summary = await recoverTeamJournal()
console.log(JSON.stringify(summary))
process.exit(0)
