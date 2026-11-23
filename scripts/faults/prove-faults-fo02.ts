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
    const { reconcileDaemonRecords } = await import(join(SRC, 'daemon/control/reconcileRecords.ts'))
    let outcome: string
    try {
      const rec = await reconcileDaemonRecords()
      outcome = `resolved ${rec.state}: ${rec.reason}`
    } catch (error) {
      outcome = `rejected ${(error as NodeJS.ErrnoException).code ?? String(error)}`
    }
    check(label, outcome === 'rejected EACCES', outcome + ' | fix reconcileDaemonRecords in src/daemon/control/reconcileRecords.ts so a stale record it cannot remove rejects with the unlink error')
  } finally {
    chmodSync(dir, 0o755)
    delete process.env.MERCURY_DAEMON_DIR
  }
}

async function sweepRegistrationUnreadable(): Promise<void> {
  const label = 'process sweep: a cockpit registration that cannot be read makes the registrations unknown, not one fewer window'
  if (!POSIX_MODES) return skip(label, 'needs POSIX modes and a non-root user')
  const home = join(scratch, 'home-sweep')
  const m = await import(join(SRC, 'daemon/process-sweep/processSweepRun.ts'))
  const dir = m.processRecordsDir(home)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `cockpit-${process.pid}-0a1b2c3d.json`)
  writeFileSync(file, JSON.stringify({ schema: 1, id: '0a1b2c3d', pid: process.pid, configHome: home, daemonDir: join(home, 'daemon'), heartbeatAt: Date.now() }))
  chmodSync(file, 0o000)
  try {
    const strict = await m.readCockpitRegistrations(home, 'strict')
    const loose = await m.readCockpitRegistrations(home)
    check(label, strict === null, `strict read answered ${JSON.stringify(strict)} | fix readCockpitRegistrations in src/daemon/process-sweep/processSweepRun.ts so the strict mode answers null when a registration file cannot be read`)
    check('readCockpitRegistrations keeps its answer for outside callers', Array.isArray(loose) && loose.length === 0, JSON.stringify(loose) + ' | fix readCockpitRegistrations in src/daemon/process-sweep/processSweepRun.ts so the call without the strict mode still answers an empty list for an unreadable registration')
  } finally {
    chmodSync(file, 0o644)
  }
}

async function scheduleSignInUnread(): Promise<void> {
  const { deriveScheduleAccountForModel } = await import(join(SRC, 'daemon/saturn/saturnAccount.ts'))
  const unread = deriveScheduleAccountForModel('fixture-model', { familyOf: () => 'anthropic', presenceOf: () => ({ credentialed: false, kind: 'none', unread: 'EACCES: permission denied' }) })
  check('schedule account: a sign-in that could not be read is refused as unread, not as no credential', !unread.ok && unread.reason === 'unread:anthropic — the sign-in could not be read (EACCES: permission denied)', JSON.stringify(unread) + ' | fix deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts so a presence with unread set is refused with the unread reason')
  const absent = deriveScheduleAccountForModel('fixture-model', { familyOf: () => 'anthropic', presenceOf: () => ({ credentialed: false, kind: 'none' }) })
  check('schedule account: an absent sign-in still reads no-credential', !absent.ok && absent.reason.startsWith('no-credential:anthropic'), JSON.stringify(absent) + ' | fix deriveScheduleAccountForModel in src/daemon/saturn/saturnAccount.ts so a presence without a credential and without unread is refused as no-credential')
}

await reconcileUnlinkRefused()
await sweepRegistrationUnreadable()
await scheduleSignInUnread()

console.log(failures === 0 ? 'prove-faults-fo02: all rows hold' : `prove-faults-fo02: ${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)
