#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineStore } from '../../src/substrate/fileStore.ts'

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
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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
    check('A: child writer exited 0', code === 0)
    const delivered = await waitFor(() => n >= 1, 5000)
    check('A: subscribe-before-exist DELIVERS a cross-process write', delivered,
      `fires ${firesBefore}→${fires}, n=${n}`)
    const before = fires
    const code2 = await childWrite(dir, 'tiny')
    check('A: second child writer exited 0', code2 === 0)
    const deliveredAgain = await waitFor(() => fires > before, 5000)
    check('A: post-upgrade watcher still delivers', deliveredAgain, `fires ${before}→${fires}`)
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
      if (attempt === 0) check('B: child writer exited 0', code === 0)
      delivered = await waitFor(() => seen >= 1, 5000)
    }
    check('B: pre-existing-file subscription delivers a cross-process write', delivered, `seen=${seen}`)
    unsub()
  }

  {
    const dir = join(root, 'case-c')
    let seen = -1
    const unsub = tiny(dir).subscribe(v => { seen = v.n }, { immediate: false })
    await tiny(dir).mutate(s => ({ ...s, n: 7 }))
    const delivered = await waitFor(() => seen === 7, 2000)
    check('C: in-process publish fans out to the subscriber', delivered, `seen=${seen}`)
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
