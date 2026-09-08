import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { defineStore, publishAtomic, VERSION_KEY } from '../../src/substrate/fileStore.ts'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-filestore-'))
process.env.MERCURY_CONFIG_DIR = tmp
const CHILD = join(import.meta.dir, 'helpers', 'fsStoreChild.ts')
const BUN = process.execPath

type Counter = { n: number }
const counterAt = (p: string) =>
  defineStore<Counter, []>({
    name: 'prove-counter',
    path: () => p,
    schemaVersion: 3,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
        ? { n: (raw as { n: number }).n }
        : null,
    empty: () => ({ n: 0 }),
    onReadFailure: 'throw',
  })()

{
  const s = counterAt(join(tmp, 's1.json'))
  ok((await s.read()).n === 0, '§1 missing file reads as empty()')
  await s.write({ n: 7 })
  ok((await s.read()).n === 7, '§1 write → read round-trip')
  const onDisk = JSON.parse(readFileSync(join(tmp, 's1.json'), 'utf8'))
  ok(onDisk[VERSION_KEY] === 3, '§1 schemaVersion stamped as additive _v')
  ok(onDisk.n === 7, '§1 data intact beside the stamp')
  writeFileSync(join(tmp, 's1-legacy.json'), '{"n": 42}')
  const legacy = counterAt(join(tmp, 's1-legacy.json'))
  ok((await legacy.read()).n === 42, '§1 legacy unstamped shape decodes')
}

{
  const corrupt = join(tmp, 's2.json')
  writeFileSync(corrupt, '{"n": tor')
  const throwing = counterAt(corrupt)
  let threw = false
  try {
    await throwing.read()
  } catch {
    threw = true
  }
  ok(threw, "§2 onReadFailure:'throw' throws on corrupt store")
  const failOpen = defineStore<Counter, []>({
    name: 'prove-failopen',
    path: () => corrupt,
    schemaVersion: 1,
    decode: raw =>
      raw && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
        ? { n: (raw as { n: number }).n }
        : null,
    empty: () => ({ n: -1 }),
    onReadFailure: 'empty',
  })()
  ok((await failOpen.read()).n === -1, "§2 onReadFailure:'empty' degrades to empty()")
}

{
  const s = counterAt(join(tmp, 's3.json'))
  await Promise.all(
    Array.from({ length: 40 }, () => s.mutate(cur => ({ n: cur.n + 1 }))),
  )
  ok((await s.read()).n === 40, '§3 40 concurrent in-process increments ⇒ exactly 40')
}

{
  const path = join(tmp, 's4.json')
  const children = Array.from({ length: 5 }, () =>
    spawn(BUN, ['run', CHILD, 'increment', path, '20'], { stdio: 'ignore' }),
  )
  const codes = await Promise.all(
    children.map(c => new Promise<number>(r => c.on('exit', code => r(code ?? 1)))),
  )
  ok(codes.every(c => c === 0), '§4 all 5 increment children exited 0')
  const s = counterAt(path)
  ok((await s.read()).n === 100, '§4 5 procs × 20 locked increments ⇒ exactly 100')
}

{
  const path = join(tmp, 's5.json')
  const listStore = defineStore<{ items: string[] }, []>({
    name: 'prove-crash',
    path: () => path,
    schemaVersion: 1,
    decode: raw =>
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { items?: unknown }).items)
        ? { items: (raw as { items: string[] }).items }
        : null,
    empty: () => ({ items: [] }),
    onReadFailure: 'throw',
  })()
  let allValid = true
  for (let round = 0; round < 3; round++) {
    const child = spawn(BUN, ['run', CHILD, 'spam', path], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    await new Promise<void>(resolve => {
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('SPAMMING')) resolve()
      })
      child.on('exit', () => resolve())
    })
    await new Promise(r => setTimeout(r, 40 + Math.random() * 120))
    child.kill('SIGKILL')
    await new Promise<void>(r => child.on('exit', () => r()))
    try {
      const v = await listStore.read()
      if (!v.items.every(i => typeof i === 'string' && i.length === 64 * 1024)) {
        allValid = false
      }
    } catch {
      allValid = false
    }
  }
  ok(allValid, '§5 kill -9 mid-publish ×3 ⇒ never a torn/invalid store (validated read)')
}

{
  const path = join(tmp, 's6.json')
  const s = counterAt(path)
  await s.write({ n: 1 })
  const seen: number[] = []
  const unsub = s.subscribe(v => seen.push(v.n), { immediate: false })
  await s.write({ n: 2 })
  await new Promise(r => setTimeout(r, 150))
  ok(seen.includes(2), '§6 in-process publish emits to subscriber')
  const before = seen.length
  let deliveredValue = 0
  for (let attempt = 0; attempt < 3 && deliveredValue === 0; attempt++) {
    const value = 9 + attempt
    const child = spawn(BUN, ['run', CHILD, 'write-once', path, String(value)], { stdio: 'ignore' })
    await new Promise<void>(r => child.on('exit', () => r()))
    const t0 = Date.now()
    while (!seen.includes(value) && Date.now() - t0 < 5000) {
      await new Promise(r => setTimeout(r, 25))
    }
    if (seen.includes(value)) deliveredValue = value
  }
  ok(deliveredValue !== 0, `§6 cross-process write emits via watcher (value ${deliveredValue || 'never'})`)
  ok(seen.length > before, '§6 watcher delivered at least one event')
  const countAt9 = seen.length
  await publishAtomic(path, readFileSync(path, 'utf8'))
  await new Promise(r => setTimeout(r, 200))
  ok(seen.length === countAt9, '§6 identical-content republish is deduped')
  unsub()
}

{
  const p = join(tmp, 's7.txt')
  await publishAtomic(p, 'one')
  await publishAtomic(p, 'two')
  ok(readFileSync(p, 'utf8') === 'two', '§7 publishAtomic replaces content')
}

rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`prove-filestore: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-filestore: ALL GREEN')
