#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-filestore-subscribe.ts — the SUBSCRIBE leg of the
//  FileStore kernel, at the PRODUCTION condition that once froze a live
//  board over this kernel.
//
//  The defect class: chokidar v4+ cannot watch a
//  not-yet-existent path — it attaches to nothing and never fires. A reader
//  that subscribed BEFORE the store's first write (a board mounts, THEN the
//  daemon creates the store file ~1s later) went permanently deaf to every
//  cross-process write: the daemon wrote live state while the board rendered
//  the empty shape forever. The prior proofs exercised read/mutate/decode
//  but NEVER a subscription, let alone one from a second process — this
//  proof is the missing production shape.
//
//  Cases:
//   A. subscribe-before-exist + CHILD-PROCESS write  → must deliver (the bug)
//   B. subscribe on an existing file + child write   → must deliver (watcher)
//   C. in-process publish fan-out                    → must deliver (unchanged)
//
//  Case A subscribes before the parent DIRECTORY exists (the production
//  shape). The child writer is THIS file re-invoked with --child-write
//  (self-spawn — no side script).
//
//  Run: ~/.bun/bin/bun run scripts/substrate/prove-filestore-subscribe.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineStore } from '../../src/substrate/fileStore.ts'

// ── child-writer mode ────────────────────────────────────────────────────────
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
    // Successive child writes are content-DISTINCT (n increments) — the
    // kernel's emission is content-deduped, so an identical write (correctly)
    // never re-fires.
    await tiny(dir).mutate(s => ({ ...s, n: s.n + 1 }))
  }
  process.exit(0)
}

// ── proof harness ────────────────────────────────────────────────────────────
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
// Recovery-ledger isolation (see prove-filestore-ordering).
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
  // ── A: the production shape — subscribe before ANYTHING exists ────────────
  {
    const dir = join(root, 'case-a', 'store') // parent dir absent too
    let n = 0
    let fires = 0
    const unsub = tiny(dir).subscribe(s => {
      fires++
      n = s.n
    }, { immediate: true })
    await new Promise(r => setTimeout(r, 300)) // immediate fire + watcher arm settle
    const firesBefore = fires
    const code = await childWrite(dir, 'tiny')
    check('A: child writer exited 0', code === 0)
    // Default pollFallback is 1000ms; the poll tick both delivers and upgrades.
    const delivered = await waitFor(() => n >= 1, 5000)
    check('A: subscribe-before-exist DELIVERS a cross-process write', delivered,
      `fires ${firesBefore}→${fires}, n=${n}`)
    // The upgrade hands off to a real watcher: a SECOND child write must also land.
    const before = fires
    const code2 = await childWrite(dir, 'tiny')
    check('A: second child writer exited 0', code2 === 0)
    const deliveredAgain = await waitFor(() => fires > before, 5000)
    check('A: post-upgrade watcher still delivers', deliveredAgain, `fires ${before}→${fires}`)
    unsub()
  }

  // ── B: existing-file watcher leg (regression guard) ───────────────────────
  {
    const dir = join(root, 'case-b')
    await tiny(dir).mutate(s => s.n === 0 ? { n: 0 } : s) // ensureExists: dir + file
    let seen = -1
    const unsub = tiny(dir).subscribe(v => { seen = v.n }, { immediate: true })
    await new Promise(r => setTimeout(r, 300))
    // ARM-RACE-SAFE (release run 29173131026: seen=0 on the 2-core ubuntu
    // runner): the watcher can still be arming when the first child write
    // lands and the lost event never replays. Retry (≤3 × 5s) — once armed
    // the next write delivers; a dead watcher still fails every attempt.
    let delivered = false
    for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
      const code = await childWrite(dir, 'tiny')
      if (attempt === 0) check('B: child writer exited 0', code === 0)
      delivered = await waitFor(() => seen >= 1, 5000)
    }
    check('B: pre-existing-file subscription delivers a cross-process write', delivered, `seen=${seen}`)
    unsub()
  }

  // ── C: in-process fan-out (unchanged fast path) ────────────────────────────
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
