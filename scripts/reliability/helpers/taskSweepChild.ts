import { sweepDeadEpochTasks } from '../../../src/utils/tasks.ts'

const list = process.env.RELIA_LIST
if (!list) throw new Error('RELIA_LIST required')
console.log(JSON.stringify(await sweepDeadEpochTasks(list)))
process.exit(0)
