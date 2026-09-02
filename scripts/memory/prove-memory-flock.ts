#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-memory-flock.ts
//  PROOF (#43 R8): the MEMORY.md index read-modify-write is atomic ACROSS PROCESSES.
//  The Scribe + the daemon-hosted Implementer are SEPARATE processes that both write
//  MEMORY.md; the in-process promise chain (serializeIndexUpdate) only serializes one
//  process, so without an OS-level lock two concurrent appends lose-update (B clobbers
//  A's pointer). A real CROSS-PROCESS concurrency test: K bun workers each append a
//  unique line to the SAME index at once — ALL K must survive.
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-memory-flock.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
const REPO = join(import.meta.dir, '..', '..')
const src = readFileSync(join(REPO, 'src', 'memdir', 'experienceCards.ts'), 'utf-8')

console.log('============================================================')
console.log(' MEMORY.md index — cross-process flock (#43 R8) — proof')
console.log('============================================================')

const ec = (await import('../../src/memdir/experienceCards.js')) as typeof import('../../src/memdir/experienceCards.js')

section('(1) functional — in-process appends both survive (the chain still holds)')
const idx1 = join(mkdtempSync(join(tmpdir(), 'memflock-')), 'MEMORY.md')
await ec.serializeIndexUpdate(idx1, e => e + '- line-A\n')
await ec.serializeIndexUpdate(idx1, e => e + '- line-B\n')
const after = readFileSync(idx1, 'utf-8')
check('both sequential appends survive', after.includes('line-A') && after.includes('line-B'))
check('an index file was created where none existed (wx create)', after.length > 0)

section('(2) cross-process — K concurrent appends from SEPARATE processes ALL survive')
const idx2 = join(mkdtempSync(join(tmpdir(), 'memflock2-')), 'MEMORY.md')
const K = 8
const workerCode =
  `globalThis.MACRO={VERSION:'1.0.0'};` +
  `const ec=await import(${JSON.stringify(join(REPO, 'src', 'memdir', 'experienceCards.ts'))});` +
  `const line='- worker-'+process.env.N+'\\n';` +
  `await ec.serializeIndexUpdate(process.env.IDX, e => e.includes(line)?null:e+line);`
const runWorker = (n: number): Promise<void> =>
  new Promise(res => {
    const c = spawn(process.execPath, ['-e', workerCode], {
      env: { ...process.env, IDX: idx2, N: String(n) },
      stdio: 'ignore',
    })
    c.on('exit', () => res())
    c.on('error', () => res())
  })
await Promise.all(Array.from({ length: K }, (_, i) => runWorker(i)))
const all = readFileSync(idx2, 'utf-8')
const present = Array.from({ length: K }, (_, i) => `worker-${i}`).filter(w => all.includes(w))
check(`all ${K} concurrent cross-process appends survived (no lost update)`, present.length === K, `present=${present.length}/${K}`)

section('(3) structural — the flock + fail-open + non-destructive create are wired')
check('applyIndexUpdate acquires a cross-process lock on the index', /lockfile\.lock\(indexPath,\s*\{[\s\S]{0,80}lockfilePath:/.test(src))
check('fail-OPEN: a lock failure still writes (never drops a memory)', /catch\s*\{[\s\S]{0,80}release = undefined/.test(src))
check('the lock is released in finally', /finally\s*\{[\s\S]{0,80}if \(release\) await release\(\)/.test(src))
check('non-destructive create (wx — never truncates an existing index)', /writeFile\(indexPath, '', \{ flag: 'wx' \}\)/.test(src))
// Atomicity was refactored into the shared atomicWriteFile helper (tmp + rename +
// unlink-on-failure) — applyIndexUpdate now delegates to it under the same lock.
check('still atomic — atomicWriteFile delegates to the durable primitive', /await atomicWriteFile\(indexPath, updated\)/.test(src) && /await durableAtomicPublish\(path, content\)/.test(src))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MEMORY-FLOCK PROOFS PASS')
else console.log(`❌ ${failures} MEMORY-FLOCK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
