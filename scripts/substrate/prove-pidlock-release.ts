#!/usr/bin/env bun
// prove-pidlock-release — the truthful lock-release
// receipt. The old releasePidLock swallowed its unlink error and returned
// `true` whenever the owner matched — on win32 a transient EPERM/EBUSY/EACCES
// (AV/indexer/open handle) left the lock PRESENT while every caller recorded
// success (residual head locks seen in the field). Release now
// settles ONE typed receipt (removed · absent · not-held · deferred · failed)
// and NEVER reports removal without verified absence of OUR record.
//
//   §1 SETTLEMENT TIERS — real fs: absent, foreign-retained (DR-07), healthy
//      one-settlement removal (DR-05), benign vanish, unreadable-refused.
//   §2 THE BOUNDED WIN32 LADDER (DR-01/03, G03) — injected unlink failures
//      ride the SHARED transient policy (renameRetryDelayMs: 50/100/200ms,
//      4 attempts) then settle `deferred`; structural codes fail fast;
//      non-win32 never retries or defers.
//   §3 THE VERIFY LAW (DR-02) — a "successful" unlink that leaves OUR record
//      visible (win32 delete-pending) is never `removed`; a successor's
//      record after our removal IS `removed` (their lock is not ours).
//   §4 HEALTH RECEIPT — notRemoved/retriedSuccesses counted with specimens.
//   §5 RECONCILIATION PINS (DR-06/07) — probePidLock reclaims only dead
//      records; a live holder survives.
//   §6 WIRING (DR-08) — every release call site consumes the receipt
//      (noteLockRelease); /doctor carries the pid-lock-release row.
//
// Hermetic: all state under a mkdtemp scratch; injected seams for platform/
// unlink/read/sleep — no wall-clock windows (sleeps are counted, not timed).
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'pidlock-release-'))

const {
  acquirePidLock,
  releasePidLock,
  probePidLock,
  pidLockReleaseHealth,
  _resetPidLockReleaseHealthForProofs,
} = await import('../../src/substrate/pidLock.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const errnoError = (code: string): NodeJS.ErrnoException => {
  const e = new Error(code) as NodeJS.ErrnoException
  e.code = code
  return e
}

// ── §1 settlement tiers (real fs) ───────────────────────────────────────────
section('§1 SETTLEMENT TIERS')
{
  _resetPidLockReleaseHealthForProofs()

  const absent = await releasePidLock(join(HOME, 'never-existed.lock'), 'me')
  check('absent path ⇒ outcome absent, 0 attempts', absent.outcome === 'absent' && absent.attempts === 0)

  const foreignPath = join(HOME, 'foreign.lock')
  const gotA = await acquirePidLock(foreignPath, 'owner-a', { liveness: 'assume-alive' })
  check('setup: owner-a acquired', gotA.held)
  const foreign = await releasePidLock(foreignPath, 'owner-b')
  check('foreign holder ⇒ not-held, 0 attempts (DR-07)', foreign.outcome === 'not-held' && foreign.attempts === 0)
  check('foreign lock RETAINED on disk (DR-07)', existsSync(foreignPath))

  const owned = await releasePidLock(foreignPath, 'owner-a')
  check('owned healthy release ⇒ removed in ONE attempt (DR-05)', owned.outcome === 'removed' && owned.attempts === 1)
  check('lock verifiably gone after removed', !existsSync(foreignPath))

  const vanish = await releasePidLock(join(HOME, 'vanish.lock'), 'me', {
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      throw errnoError('ENOENT')
    },
  })
  check('ENOENT during unlink ⇒ removed (benign vanish)', vanish.outcome === 'removed' && vanish.attempts === 1)

  const unreadable = await releasePidLock(join(HOME, 'unreadable.lock'), 'me', {
    readRaw: async () => ({ kind: 'unreadable', code: 'EACCES' }),
  })
  check(
    'unreadable record ⇒ failed with named errno, nothing unlinked blind',
    unreadable.outcome === 'failed' && unreadable.attempts === 0 && unreadable.fsCode === 'EACCES',
  )
}

// ── §2 the bounded win32 ladder ─────────────────────────────────────────────
section('§2 THE BOUNDED WIN32 LADDER (DR-01/03, G03)')
for (const code of ['EPERM', 'EBUSY', 'EACCES'] as const) {
  _resetPidLockReleaseHealthForProofs()
  const delays: number[] = []
  let unlinkCalls = 0
  const receipt = await releasePidLock(join(HOME, `transient-${code}.lock`), 'me', {
    platform: 'win32',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      unlinkCalls++
      throw errnoError(code)
    },
    sleepMs: async ms => {
      delays.push(ms)
    },
  })
  check(
    `persistent ${code} ⇒ deferred after the FULL ladder (DR-01)`,
    receipt.outcome === 'deferred' && receipt.attempts === 4 && receipt.fsCode === code,
    `attempts=${receipt.attempts} fsCode=${receipt.fsCode}`,
  )
  check(
    `${code} rode the SHARED 50/100/200ms policy (DR-03)`,
    unlinkCalls === 4 && delays.join(',') === '50,100,200',
    `delays=[${delays.join(',')}]`,
  )
  const h = pidLockReleaseHealth()
  check(
    `${code} counted in the health receipt with a specimen (DR-04)`,
    h.notRemoved.count === 1 && h.notRemoved.last?.outcome === 'deferred' && h.notRemoved.last?.fsCode === code,
  )
}
{
  _resetPidLockReleaseHealthForProofs()
  let calls = 0
  const saved = await releasePidLock(join(HOME, 'transient-heals.lock'), 'me', {
    platform: 'win32',
    readRaw: async () =>
      calls >= 3 ? { kind: 'missing' as const } : { kind: 'ok' as const, raw: JSON.stringify({ owner: 'me', pid: 4242 }) },
    doUnlink: async () => {
      calls++
      if (calls < 3) throw errnoError('EPERM')
    },
    sleepMs: async () => {},
  })
  check('EPERM ×2 then success ⇒ removed at attempt 3', saved.outcome === 'removed' && saved.attempts === 3)
  check('retried success counted in health', pidLockReleaseHealth().retriedSuccesses.count === 1)

  const structuralWin = await releasePidLock(join(HOME, 'structural.lock'), 'me', {
    platform: 'win32',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      throw errnoError('EISDIR')
    },
  })
  check(
    'structural code on win32 ⇒ failed FAST (no ladder)',
    structuralWin.outcome === 'failed' && structuralWin.attempts === 1 && structuralWin.fsCode === 'EISDIR',
  )

  const posixSleeps: number[] = []
  const posixEperm = await releasePidLock(join(HOME, 'posix-eperm.lock'), 'me', {
    platform: 'linux',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      throw errnoError('EPERM')
    },
    sleepMs: async ms => {
      posixSleeps.push(ms)
    },
  })
  check(
    'non-win32 EPERM ⇒ failed immediately — never deferred, never retried',
    posixEperm.outcome === 'failed' && posixEperm.attempts === 1 && posixSleeps.length === 0,
  )
}

// ── §3 the verify law ───────────────────────────────────────────────────────
section('§3 THE VERIFY LAW (DR-02)')
{
  // A "successful" unlink whose path still carries OUR record — the win32
  // delete-pending shape. Must NEVER settle removed.
  const stillOurs = await releasePidLock(join(HOME, 'delete-pending.lock'), 'me', {
    platform: 'win32',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {},
    sleepMs: async () => {},
  })
  check(
    'win32 delete-pending (our record survives unlink) ⇒ deferred, never removed',
    stillOurs.outcome === 'deferred' && stillOurs.fsCode === 'EBUSY' && stillOurs.attempts === 4,
  )

  const stillOursPosix = await releasePidLock(join(HOME, 'phantom-posix.lock'), 'me', {
    platform: 'darwin',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {},
    sleepMs: async () => {},
  })
  check(
    'posix phantom-present after unlink ⇒ failed, never removed',
    stillOursPosix.outcome === 'failed' && stillOursPosix.outcome !== ('removed' as string),
  )

  let reads = 0
  const successor = await releasePidLock(join(HOME, 'successor.lock'), 'me', {
    readRaw: async () => {
      reads++
      return reads === 1
        ? { kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }
        : { kind: 'ok', raw: JSON.stringify({ owner: 'them', pid: 777 }) }
    },
    doUnlink: async () => {},
  })
  check(
    'successor claimed the vacancy after our removal ⇒ removed (their lock untouched)',
    successor.outcome === 'removed' && successor.attempts === 1,
  )
}

// ── §4 health receipt ───────────────────────────────────────────────────────
section('§4 HEALTH RECEIPT')
{
  _resetPidLockReleaseHealthForProofs()
  const empty = pidLockReleaseHealth()
  check('reset seam clears the receipt', empty.notRemoved.count === 0 && empty.retriedSuccesses.count === 0)
  await releasePidLock(join(HOME, 'health.lock'), 'me', {
    platform: 'linux',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      throw errnoError('EROFS')
    },
  })
  const h = pidLockReleaseHealth()
  check(
    'failed release lands a specimen (path + code + attempts + at)',
    h.notRemoved.count === 1 &&
      h.notRemoved.last !== null &&
      h.notRemoved.last.fsCode === 'EROFS' &&
      h.notRemoved.last.attempts === 1 &&
      h.notRemoved.last.path.endsWith('health.lock') &&
      h.notRemoved.last.atMs > 0,
  )
}

// ── §5 reconciliation pins ──────────────────────────────────────────────────
section('§5 RECONCILIATION PINS (DR-06/07)')
{
  const deadPath = join(HOME, 'dead-holder.lock')
  const got = await acquirePidLock(deadPath, 'dead-owner', { liveness: 'assume-dead' })
  check('setup: acquired for the dead-holder fixture', got.held)
  // Rewrite the record with a dead pid (kept parseable) so the probe judges
  // it stale — pid 1 under assume-dead polarity reads reclaimable.
  const { writeFileSync } = await import('node:fs')
  writeFileSync(deadPath, JSON.stringify({ owner: 'dead-owner', pid: 1, acquiredAt: 1 }))
  const probed = await probePidLock(deadPath, { liveness: 'assume-dead', reclaimStale: true })
  check('dead record probed null + reclaimed from disk (DR-06)', probed === null && !existsSync(deadPath))

  const livePath = join(HOME, 'live-holder.lock')
  await acquirePidLock(livePath, 'live-owner', { liveness: 'assume-alive' })
  const live = await probePidLock(livePath, { liveness: 'assume-alive', reclaimStale: true })
  check('live holder survives reconciliation (DR-07)', live !== null && existsSync(livePath))
}

// ── §6 wiring ───────────────────────────────────────────────────────────────
section('§6 WIRING (DR-08)')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const control = src('src/daemon/controlSocket.ts')
  const tasks = src('src/utils/tasks.ts')
  check('daemon supervisor release consumes the receipt', control.includes('noteLockRelease('))
  // (The old scheduler lock died with its engine; the
  // supervisor + task locks are the living consumers.)
  check('task-lock release consumes the receipt', tasks.includes('noteLockRelease('))
  // A discarded receipt is a statement-position `await releasePidLock(…)`
  // line: not wrapped by noteLockRelease on the same line, not an argument
  // line (trailing comma), not captured (`= await`/`return await`).
  const bare = [control, tasks].some(s =>
    s.split('\n').some(
      line =>
        /^\s*await releasePidLock\(/.test(line) &&
        !line.includes('noteLockRelease(') &&
        !line.trimEnd().endsWith(','),
    ),
  )
  check('no call site discards a release receipt (bare await)', !bare)
  const doctor = src('src/utils/healthReport.ts')
  check(
    '/doctor carries the pid-lock-release row reading the health accessor',
    doctor.includes("id: 'pid-lock-release'") && doctor.includes('pidLockReleaseHealth'),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-pidlock-release: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-pidlock-release: all green')
