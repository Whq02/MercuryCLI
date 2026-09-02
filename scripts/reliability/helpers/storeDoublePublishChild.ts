import { defineStore } from '../../../src/substrate/fileStore.ts'

const path = process.env.RELIA_STORE
if (!path) throw new Error('RELIA_STORE required')
const store = defineStore<{ n: number }, []>({
  name: 'relia-counter',
  path: () => path,
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
      ? { n: (raw as { n: number }).n }
      : null,
  empty: () => ({ n: 0 }),
  onReadFailure: 'empty',
})()
await store.write({ n: 1 })
await store.write({ n: 2 })
process.exit(0)
