import { defineStore } from '../../../src/substrate/fileStore.ts'

const [mode, path, arg] = process.argv.slice(2) as [string, string, string?]

const counter = defineStore<{ n: number; blob?: string }, []>({
  name: 'prove-counter-child',
  path: () => path,
  schemaVersion: 1,
  decode: raw =>
    raw && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
      ? { n: (raw as { n: number }).n, ...((raw as { blob?: string }).blob ? { blob: (raw as { blob: string }).blob } : {}) }
      : null,
  empty: () => ({ n: 0 }),
  onReadFailure: 'throw',
})

const list = defineStore<{ items: string[] }, []>({
  name: 'prove-list-child',
  path: () => path,
  schemaVersion: 1,
  decode: raw =>
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { items?: unknown }).items) &&
    ((raw as { items: unknown[] }).items as unknown[]).every(i => typeof i === 'string')
      ? { items: (raw as { items: string[] }).items }
      : null,
  empty: () => ({ items: [] }),
  onReadFailure: 'throw',
})

if (mode === 'increment') {
  const n = Number(arg ?? '10')
  for (let i = 0; i < n; i++) {
    await counter().mutate(cur => ({ ...cur, n: cur.n + 1 }))
  }
  process.exit(0)
} else if (mode === 'spam') {
  const chunk = 'x'.repeat(64 * 1024)
  console.log('SPAMMING')
  for (;;) {
    await list().mutate(cur => ({ items: [...cur.items, chunk] }))
  }
} else if (mode === 'write-once') {
  await counter().write({ n: Number(arg ?? '1') })
  process.exit(0)
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
