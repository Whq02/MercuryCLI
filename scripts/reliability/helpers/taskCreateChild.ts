import { createTask, listTasks } from '../../../src/utils/tasks.ts'

const list = process.env.RELIA_LIST
if (!list) throw new Error('RELIA_LIST required')
const id = await createTask(list, {
  subject: 'post-reset live probe',
  description: 'epoch liveness probe',
  status: 'pending',
  blocks: [],
  blockedBy: [],
})
const tasks = await listTasks(list)
console.log(JSON.stringify({ id, live: tasks.map(t => t.id) }))
process.exit(0)
