#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}
const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
const scratch = mkdtempSync(join(tmpdir(), 'prove-faults-fo02-'))

async function reconcileUnlinkRefused(): Promise<void> {
  const label = 'reconcileDaemonRecords: a stale record it cannot remove is an error, not "vanished" and clean'
  if (!POSIX_MODES) return skip(label, 'needs POSIX modes and a non-root user')
  const dir = join(scratch, 'daemon-locked')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'control.key'), 'fixture-key')
  chmodSync(dir, 0o555)
  process.env.MERCURY_DAEMON_DIR = dir
  try {
    const { reconcileDaemonRecords } = await import(join(SRC, 'daemon/reconcileRecords.ts'))
    let outcome: string
    try {
      const rec = await reconcileDaemonRecords()
      outcome = `resolved ${rec.state}: ${rec.reason}`
    } catch (error) {
      outcome = `rejected ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    }
    check(label, outcome === 'rejected EACCES', outcome)
  } finally {
    chmodSync(dir, 0o755)
    delete process.env.MERCURY_DAEMON_DIR
  }
}

await reconcileUnlinkRefused()

console.log(failures === 0 ? 'prove-faults-fo02: all rows hold' : `prove-faults-fo02: ${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)
