// helper — one COLD-runtime locked mutation on a store path (the
// process has no in-memory last-good witness, so a recoverable read must
// quarantine and resume from the declared empty()).
import { defineStore } from '../../../src/substrate/fileStore.ts'

const path = process.env.RELIA_STORE
if (!path) throw new Error('RELIA_STORE required')
const store = defineStore<{ n: number }, []>({
  name: 'relia-cold-counter',
  path: () => path,
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
      ? { n: (raw as { n: number }).n }
      : null,
  empty: () => ({ n: 0 }),
  onReadFailure: 'empty',
})()
await store.mutate(v => ({ n: v.n + 1 }))
process.exit(0)
