#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineStore } from '../../src/platform/substrate/fileStore.ts'

if (process.argv[2] === '--child-write') {
  const dir = process.argv[3]
  const which = process.argv[4]
  if (!dir || !which) {
    console.error('usage: --child-write <dir> <tiny>')
    process.exit(2)
  }
  {
    const tiny = defineStore<{ n: number }, [string]>({
      name: 'tinyProof',
      schemaVersion: 1,
      path: d => join(d, 'tiny.json'),
      onReadFailure: 'empty',
      empty: () => ({ n: 0 }),
      decode: raw =>
        raw !== null && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
          ? { n: (raw as { n: number }).n }
          : null,
    })
    await tiny(dir).mutate(s => ({ ...s, n: s.n + 1 }))
  }
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}

const bunBin = process.execPath
function childWrite(dir: string, which: 'tiny'): Promise<number> {
  return new Promise(resolve => {
    const c = spawn(bunBin, ['run', import.meta.path, '--child-write', dir, which], {
      env: { ...process.env },
      stdio: 'inherit',
    })
    c.on('exit', code => resolve(code ?? 1))
  })
}

async function waitFor(cond: () => boolean, ms: number, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, step))
  }
  return cond()
}

const root = mkdtempSync(join(tmpdir(), 'filestore-subscribe-'))
process.env.MERCURY_CONFIG_DIR = root

console.log('============================================================')
console.log(' FileStore subscribe — cross-process, subscribe-before-exist')
console.log('============================================================')

const tiny = defineStore<{ n: number }, [string]>({
  name: 'tinyProof',
  schemaVersion: 1,
  path: d => join(d, 'tiny.json'),
  onReadFailure: 'empty',
  empty: () => ({ n: 0 }),
  decode: raw =>
    raw !== null && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number'
      ? { n: (raw as { n: number }).n }
      : null,
})

try {
  {
    const dir = join(root, 'case-a', 'store')
    let n = 0
    let fires = 0
    const unsub = tiny(dir).subscribe(s => {
      fires++
      n = s.n
    }, { immediate: true })
    await new Promise(r => setTimeout(r, 300))
    const firesBefore = fires
    const code = await childWrite(dir, 'tiny')
    check('A: child writer exited 0', code === 0, '',
      'the --child-write branch at the top of this file exited non-zero; its mutate through defineStore in src/platform/substrate/fileStore.ts threw, see the child stderr above')
    const delivered = await waitFor(() => n >= 1, 5000)
    check('A: subscribe-before-exist DELIVERS a cross-process write', delivered,
      `fires ${firesBefore}→${fires}, n=${n}`,
      'a subscriber attached before the file exists got no cross-process write; check startWatcherOf (the ENOENT branch calling startPollUntilExists) and subscribeChanges in src/platform/substrate/fileStore.ts')
    const before = fires
    const code2 = await childWrite(dir, 'tiny')
    check('A: second child writer exited 0', code2 === 0, '',
      'the --child-write branch at the top of this file exited non-zero; its mutate through defineStore in src/platform/substrate/fileStore.ts threw, see the child stderr above')
    const deliveredAgain = await waitFor(() => fires > before, 5000)
    check('A: post-upgrade watcher still delivers', deliveredAgain, `fires ${before}→${fires}`,
      'after the poll-until-exists stage the subscriber stopped firing; check that startPollUntilExistsOf in src/platform/substrate/fileStore.ts hands over to a watcher or poll that keeps emitting')
    unsub()
  }

  {
    const dir = join(root, 'case-b')
    await tiny(dir).mutate(s => s.n === 0 ? { n: 0 } : s)
    let seen = -1
    const unsub = tiny(dir).subscribe(v => { seen = v.n }, { immediate: true })
    await new Promise(r => setTimeout(r, 300))
    let delivered = false
    for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
      const code = await childWrite(dir, 'tiny')
      if (attempt === 0) check('B: child writer exited 0', code === 0, '',
        'the --child-write branch at the top of this file exited non-zero; its mutate through defineStore in src/platform/substrate/fileStore.ts threw, see the child stderr above')
      delivered = await waitFor(() => seen >= 1, 5000)
    }
    check('B: pre-existing-file subscription delivers a cross-process write', delivered, `seen=${seen}`,
      'a subscriber on an existing file got no cross-process write in 3 attempts; check the chokidar watcher in startWatcherOf and scheduleEmit in src/platform/substrate/fileStore.ts')
    unsub()
  }

  {
    const dir = join(root, 'case-c')
    let seen = -1
    const unsub = tiny(dir).subscribe(v => { seen = v.n }, { immediate: false })
    await tiny(dir).mutate(s => ({ ...s, n: 7 }))
    const delivered = await waitFor(() => seen === 7, 2000)
    check('C: in-process publish fans out to the subscriber', delivered, `seen=${seen}`,
      'a mutate in this process did not reach its own subscriber within 2 s; check how the store publishes to rt.listeners after a write in src/platform/substrate/fileStore.ts')
    unsub()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL FILESTORE-SUBSCRIBE PROOFS PASS')
