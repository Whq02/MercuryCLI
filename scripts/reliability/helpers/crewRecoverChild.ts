import { recoverCrewJournal } from '../../../src/utils/crew/crewOperations.ts'

const summary = await recoverCrewJournal()
console.log(JSON.stringify(summary))
process.exit(0)
