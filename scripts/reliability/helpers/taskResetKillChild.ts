import { resetTaskList } from '../../../src/utils/tasks.ts'

const list = process.env.RELIA_LIST
if (!list) throw new Error('RELIA_LIST required')
await resetTaskList(list)
process.exit(0)
