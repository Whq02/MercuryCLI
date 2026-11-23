#!/usr/bin/env bun
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'pidlock-release-'))

const {
  acquirePidLock,
  releasePidLock,
  probePidLock,
  pidLockReleaseHealth,
  _resetPidLockReleaseHealthForProofs,
} = await import('../../src/platform/substrate/pidLock.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const errnoError = (code: string): NodeJS.ErrnoException => {
  const e = new Error(code) as NodeJS.ErrnoException
  e.code = code
  return e
}

section('§1 SETTLEMENT TIERS')
{
  _resetPidLockReleaseHealthForProofs()

  const absent = await releasePidLock(join(HOME, 'never-existed.lock'), 'me')
  check('absent path ⇒ outcome absent, 0 attempts', absent.outcome === 'absent' && absent.attempts === 0, '', 'releasePidLock in src/platform/substrate/pidLock.ts must return outcome absent with 0 attempts when the lock file does not exist')

  const foreignPath = join(HOME, 'foreign.lock')
  const gotA = await acquirePidLock(foreignPath, 'owner-a', { liveness: 'assume-alive' })
  check('setup: owner-a acquired', gotA.held, '', 'acquirePidLock in src/platform/substrate/pidLock.ts must take a lock that is not held, with liveness assume-alive')
  const foreign = await releasePidLock(foreignPath, 'owner-b')
  check('foreign holder ⇒ not-held, 0 attempts (DR-07)', foreign.outcome === 'not-held' && foreign.attempts === 0, '', 'releasePidLock in src/platform/substrate/pidLock.ts must return not-held with 0 attempts when the record names another owner')
  check('foreign lock RETAINED on disk (DR-07)', existsSync(foreignPath), '', 'releasePidLock in src/platform/substrate/pidLock.ts must not unlink a lock whose record names another owner')

  const owned = await releasePidLock(foreignPath, 'owner-a')
  check('owned healthy release ⇒ removed in ONE attempt (DR-05)', owned.outcome === 'removed' && owned.attempts === 1, '', 'releasePidLock in src/platform/substrate/pidLock.ts must unlink an owned lock on the first attempt and report removed')
  check('lock verifiably gone after removed', !existsSync(foreignPath), '', 'releasePidLock in src/platform/substrate/pidLock.ts must report removed only when the lock file is gone')

  const vanish = await releasePidLock(join(HOME, 'vanish.lock'), 'me', {
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      throw errnoError('ENOENT')
    },
  })
  check('ENOENT during unlink ⇒ removed (benign vanish)', vanish.outcome === 'removed' && vanish.attempts === 1, '', 'releasePidLock in src/platform/substrate/pidLock.ts must treat an ENOENT from the unlink as removed on that attempt')

  const unreadable = await releasePidLock(join(HOME, 'unreadable.lock'), 'me', {
    readRaw: async () => ({ kind: 'unreadable', code: 'EACCES' }),
  })
  check(
    'unreadable record ⇒ failed with named errno, nothing unlinked blind',
    unreadable.outcome === 'failed' && unreadable.attempts === 0 && unreadable.fsCode === 'EACCES',
    '',
    'releasePidLock in src/platform/substrate/pidLock.ts must return failed with 0 attempts and the read error code when the record cannot be read, and must not unlink',
  )
}

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
    'releasePidLock in src/platform/substrate/pidLock.ts must keep retrying EPERM, EBUSY and EACCES on win32 up to 4 attempts, then return deferred with the code (see renameRetryDelayMs)',
  )
  check(
    `${code} rode the SHARED 50/100/200ms policy (DR-03)`,
    unlinkCalls === 4 && delays.join(',') === '50,100,200',
    `delays=[${delays.join(',')}]`,
    'releasePidLock in src/platform/substrate/pidLock.ts must sleep with the delays renameRetryDelayMs returns, which this proof expects to be 50, 100 and 200 ms',
  )
  const h = pidLockReleaseHealth()
  check(
    `${code} counted in the health receipt with a specimen (DR-04)`,
    h.notRemoved.count === 1 && h.notRemoved.last?.outcome === 'deferred' && h.notRemoved.last?.fsCode === code,
    '',
    'the settle step in releasePidLock in src/platform/substrate/pidLock.ts must add one to releaseHealth.notRemoved.count and store the deferred receipt as last',
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
  check('EPERM ×2 then success ⇒ removed at attempt 3', saved.outcome === 'removed' && saved.attempts === 3, '', 'releasePidLock in src/platform/substrate/pidLock.ts must retry a transient win32 error and report removed with the attempt number that worked')
  check('retried success counted in health', pidLockReleaseHealth().retriedSuccesses.count === 1, '', 'the settle step in releasePidLock in src/platform/substrate/pidLock.ts must add one to releaseHealth.retriedSuccesses.count when removed took more than one attempt')

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
    '',
    'releasePidLock in src/platform/substrate/pidLock.ts must return failed after one attempt for a code that renameRetryDelayMs and isTransientHeldFileCode do not treat as transient',
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
    '',
    'releasePidLock in src/platform/substrate/pidLock.ts must retry EPERM only when the platform is win32; renameRetryDelayMs and isTransientHeldFileCode decide that',
  )
}

section('§3 THE VERIFY LAW (DR-02)')
{
  const stillOurs = await releasePidLock(join(HOME, 'delete-pending.lock'), 'me', {
    platform: 'win32',
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {},
    sleepMs: async () => {},
  })
  check(
    'win32 delete-pending (our record survives unlink) ⇒ deferred, never removed',
    stillOurs.outcome === 'deferred' && stillOurs.fsCode === 'EBUSY' && stillOurs.attempts === 4,
    '',
    'releasePidLock in src/platform/substrate/pidLock.ts must read the record again after an unlink that threw nothing and, if it is still ours, retry as EBUSY and end deferred, never removed',
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
    '',
    'releasePidLock in src/platform/substrate/pidLock.ts must read the record again after unlink and, when it is still ours off win32, return failed rather than removed',
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
    '',
    'releasePidLock in src/platform/substrate/pidLock.ts must report removed when the record read after unlink names a different owner, and leave that lock alone',
  )
}

section('§4 HEALTH RECEIPT')
{
  _resetPidLockReleaseHealthForProofs()
  const empty = pidLockReleaseHealth()
  check('reset seam clears the receipt', empty.notRemoved.count === 0 && empty.retriedSuccesses.count === 0, '', '_resetPidLockReleaseHealthForProofs in src/platform/substrate/pidLock.ts must zero both notRemoved and retriedSuccesses')
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
    '',
    'the settle step in releasePidLock in src/platform/substrate/pidLock.ts must store path, fsCode, attempts and atMs of a failed release in releaseHealth.notRemoved',
  )
}

section('§5 RECONCILIATION PINS (DR-06/07)')
{
  const deadPath = join(HOME, 'dead-holder.lock')
  const got = await acquirePidLock(deadPath, 'dead-owner', { liveness: 'assume-dead' })
  check('setup: acquired for the dead-holder fixture', got.held, '', 'acquirePidLock in src/platform/substrate/pidLock.ts must take a lock that is not held, with liveness assume-dead')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(deadPath, JSON.stringify({ owner: 'dead-owner', pid: 1, acquiredAt: 1 }))
  const probed = await probePidLock(deadPath, { liveness: 'assume-dead', reclaimStale: true })
  check('dead record probed null + reclaimed from disk (DR-06)', probed === null && !existsSync(deadPath), '', 'probePidLock in src/platform/substrate/pidLock.ts must return null and remove the file when the holder is dead and reclaimStale is true')

  const livePath = join(HOME, 'live-holder.lock')
  await acquirePidLock(livePath, 'live-owner', { liveness: 'assume-alive' })
  const live = await probePidLock(livePath, { liveness: 'assume-alive', reclaimStale: true })
  check('live holder survives reconciliation (DR-07)', live !== null && existsSync(livePath), '', 'probePidLock in src/platform/substrate/pidLock.ts must return the holder and keep the file when the holder is alive')
}

section('§6 WIRING (DR-08)')
{
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const { pidLockReleaseHealth: releasesNow } = await import('../../src/platform/substrate/pidLock.ts')
  const lockSays = await crewChecks().find(row => row.id === 'pid-lock-release')?.run()
  const lockHealth = releasesNow()
  check(
    '/health carries the pid-lock-release row reading the health accessor',
    lockSays !== undefined && (lockHealth.notRemoved.count > 0 ? lockSays.status === 'warn' && lockSays.evidence.startsWith(`${lockHealth.notRemoved.count} lock release(s) settled`) : lockSays.status === 'ok' && lockSays.evidence === (lockHealth.retriedSuccesses.count > 0 ? `releases healthy (${lockHealth.retriedSuccesses.count} saved by the bounded retry)` : 'releases healthy')),
    lockSays?.evidence,
    'the pid-lock-release row in src/platform/health/sections/crew/appends.ts must take its status and evidence from pidLockReleaseHealth',
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-pidlock-release: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-pidlock-release: all green')
