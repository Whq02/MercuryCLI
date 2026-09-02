import { listTasks } from '../../../src/utils/tasks.ts'

const list = process.env.RELIA_LIST
if (!list) throw new Error('RELIA_LIST required')
const tasks = await listTasks(list)
console.log(JSON.stringify(tasks.map(t => t.id)))
process.exit(0)
