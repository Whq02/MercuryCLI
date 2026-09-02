// FC6 child — run the production resetTaskList; the parent SIGKILLs this
// process once the high-water mark publication appears (mid unlink loop).
import { resetTaskList } from '../../../src/utils/tasks.ts'

const list = process.env.RELIA_LIST
if (!list) throw new Error('RELIA_LIST required')
await resetTaskList(list)
process.exit(0)
