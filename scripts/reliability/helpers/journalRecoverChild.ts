// helper — run journal recovery in a child (the parent kills it at a
// recovery boundary via MERCURY_FAULT_INJECT to prove recovery is resumable).
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { recoverJournalDir } from '../../../src/substrate/operationJournal.ts'

const dir = process.env.RELIA_JOURNAL_DIR
const work = process.env.RELIA_WORK_DIR
if (!dir || !work) throw new Error('RELIA_JOURNAL_DIR + RELIA_WORK_DIR required')
await recoverJournalDir(dir, {
  'relia-two-step': {
    compensate: async () => {
      rmSync(join(work, 'marker-1'), { force: true })
      rmSync(join(work, 'marker-2'), { force: true })
    },
  },
})
process.exit(0)
