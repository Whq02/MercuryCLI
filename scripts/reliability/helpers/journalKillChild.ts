// kill child — one journaled operation (two marker-file steps) under
// a parent-set MERCURY_FAULT_INJECT kill point at an exact journal boundary.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runJournaledOperation } from '../../../src/substrate/operationJournal.ts'

const dir = process.env.RELIA_JOURNAL_DIR
const work = process.env.RELIA_WORK_DIR
const key = process.env.RELIA_KEY ?? 'k1'
if (!dir || !work) throw new Error('RELIA_JOURNAL_DIR + RELIA_WORK_DIR required')

await runJournaledOperation({
  journalDir: dir,
  ownerKey: 'relia-owner',
  kind: 'relia-two-step',
  idempotencyKey: key,
  steps: [
    {
      id: 's1',
      target: join(work, 'marker-1'),
      run: async () => {
        writeFileSync(join(work, 'marker-1'), 'one')
      },
    },
    {
      id: 's2',
      target: join(work, 'marker-2'),
      run: async () => {
        writeFileSync(join(work, 'marker-2'), 'two')
      },
    },
  ],
  compensate: async () => {
    const { rmSync } = await import('node:fs')
    rmSync(join(work, 'marker-1'), { force: true })
    rmSync(join(work, 'marker-2'), { force: true })
  },
  result: () => ({ made: 2 }),
})
process.exit(0)
