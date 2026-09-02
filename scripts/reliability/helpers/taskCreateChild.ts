// FC6 liveness child — a CURRENT-epoch task must serve as LIVE:
// creates one task in RELIA_LIST, then prints { id, live: [ids] } from the
// production listTasks. The other half of the epoch law — dead stays dead
// (the resurrection leg), live stays live (this leg); a flipped epoch
// comparison kills exactly one of them.
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
