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

section('§1 SETTLEMENT TIERS')
{
  _resetPidLockReleaseHealthForProofs()

  const absent = await releasePidLock(join(HOME, 'never-existed.lock'), 'me')
  check('absent path ⇒ outcome absent, 0 attempts', absent.outcome === 'absent' && absent.attempts === 0, `got ${JSON.stringify(absent)}; releasePidLock in src/substrate/pidLock.ts must return outcome absent with 0 attempts when the lock file is missing`)

  const foreignPath = join(HOME, 'foreign.lock')
  const gotA = await acquirePidLock(foreignPath, 'owner-a', { liveness: 'assume-alive' })
  check('setup: owner-a acquired', gotA.held, 'acquirePidLock in src/substrate/pidLock.ts did not take a fresh lock file')
  const foreign = await releasePidLock(foreignPath, 'owner-b')
  check('foreign holder ⇒ not-held, 0 attempts (DR-07)', foreign.outcome === 'not-held' && foreign.attempts === 0, `got ${JSON.stringify(foreign)}; releasePidLock in src/substrate/pidLock.ts must return not-held without unlinking when the recorded owner differs`)
  check('foreign lock RETAINED on disk (DR-07)', existsSync(foreignPath), 'releasePidLock in src/substrate/pidLock.ts must not unlink a lock another owner holds')

  const owned = await releasePidLock(foreignPath, 'owner-a')
  check('owned healthy release ⇒ removed in ONE attempt (DR-05)', owned.outcome === 'removed' && owned.attempts === 1, `got ${JSON.stringify(owned)}; releasePidLock in src/substrate/pidLock.ts must remove an owned lock on the first unlink`)
  check('lock verifiably gone after removed', !existsSync(foreignPath), 'releasePidLock in src/substrate/pidLock.ts reported removed but the lock file is still on disk')

  const vanish = await releasePidLock(join(HOME, 'vanish.lock'), 'me', {
    readRaw: async () => ({ kind: 'ok', raw: JSON.stringify({ owner: 'me', pid: 4242 }) }),
    doUnlink: async () => {
      throw errnoError('ENOENT')
    },
  })
  check('ENOENT during unlink ⇒ removed (benign vanish)', vanish.outcome === 'removed' && vanish.attempts === 1, `got ${JSON.stringify(vanish)}; releasePidLock in src/substrate/pidLock.ts must settle an ENOENT from unlink as removed`)

  const unreadable = await releasePidLock(join(HOME, 'unreadable.lock'), 'me', {
    readRaw: async () => ({ kind: 'unreadable', code: 'EACCES' }),
  })
  check(
    'unreadable record ⇒ failed with named errno, nothing unlinked blind',
    unreadable.outcome === 'failed' && unreadable.attempts === 0 && unreadable.fsCode === 'EACCES',
    `got ${JSON.stringify(unreadable)}; releasePidLock in src/substrate/pidLock.ts must return failed with the read errno and not unlink when the record cannot be read`,
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
    `attempts=${receipt.attempts} fsCode=${receipt.fsCode}; releasePidLock in src/substrate/pidLock.ts must settle a persistent transient code on win32 as deferred after 4 attempts`,
  )
  check(
    `${code} rode the SHARED 50/100/200ms policy (DR-03)`,
    unlinkCalls === 4 && delays.join(',') === '50,100,200',
    `delays=[${delays.join(',')}] unlinkCalls=${unlinkCalls}; the retry delays releasePidLock uses (renameRetryDelayMs, imported in src/substrate/pidLock.ts) must be 50,100,200`,
  )
  const h = pidLockReleaseHealth()
  check(
    `${code} counted in the health receipt with a specimen (DR-04)`,
    h.notRemoved.count === 1 && h.notRemoved.last?.outcome === 'deferred' && h.notRemoved.last?.fsCode === code,
    `health=${JSON.stringify(h)}; the settle step of releasePidLock in src/substrate/pidLock.ts must record a deferred release in the health receipt`,
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
  check('EPERM ×2 then success ⇒ removed at attempt 3', saved.outcome === 'removed' && saved.attempts === 3, `got ${JSON.stringify(saved)}; releasePidLock in src/substrate/pidLock.ts must retry a transient code and settle removed at the attempt that succeeds`)
  check('retried success counted in health', pidLockReleaseHealth().retriedSuccesses.count === 1, 'the settle step of releasePidLock in src/substrate/pidLock.ts must count a removal after more than one attempt in retriedSuccesses')

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
    `got ${JSON.stringify(structuralWin)}; releasePidLock in src/substrate/pidLock.ts must not retry a non-transient code on win32`,
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
    `got ${JSON.stringify(posixEperm)} sleeps=${posixSleeps.length}; releasePidLock in src/substrate/pidLock.ts must retry only on win32`,
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
    `got ${JSON.stringify(stillOurs)}; releasePidLock in src/substrate/pidLock.ts must re-read after unlink and treat a surviving own record as EBUSY on win32`,
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
    `got ${JSON.stringify(stillOursPosix)}; releasePidLock in src/substrate/pidLock.ts must not report removed while our own record is still readable`,
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
    `got ${JSON.stringify(successor)}; releasePidLock in src/substrate/pidLock.ts must settle removed when the re-read shows another owner's record`,
  )
}

section('§4 HEALTH RECEIPT')
{
  _resetPidLockReleaseHealthForProofs()
  const empty = pidLockReleaseHealth()
  check('reset seam clears the receipt', empty.notRemoved.count === 0 && empty.retriedSuccesses.count === 0, `health=${JSON.stringify(empty)}; _resetPidLockReleaseHealthForProofs in src/substrate/pidLock.ts must zero both counters`)
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
    `health=${JSON.stringify(h)}; the settle step of releasePidLock in src/substrate/pidLock.ts must record path, fsCode, attempts and atMs for a failed release`,
  )
}

section('§5 RECONCILIATION PINS (DR-06/07)')
{
  const deadPath = join(HOME, 'dead-holder.lock')
  const got = await acquirePidLock(deadPath, 'dead-owner', { liveness: 'assume-dead' })
  check('setup: acquired for the dead-holder fixture', got.held, 'acquirePidLock in src/substrate/pidLock.ts did not take a fresh lock file')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(deadPath, JSON.stringify({ owner: 'dead-owner', pid: 1, acquiredAt: 1 }))
  const probed = await probePidLock(deadPath, { liveness: 'assume-dead', reclaimStale: true })
  check('dead record probed null + reclaimed from disk (DR-06)', probed === null && !existsSync(deadPath), `probe=${JSON.stringify(probed)}; probePidLock in src/substrate/pidLock.ts with reclaimStale must return null and unlink a lock whose pid is dead`)

  const livePath = join(HOME, 'live-holder.lock')
  await acquirePidLock(livePath, 'live-owner', { liveness: 'assume-alive' })
  const live = await probePidLock(livePath, { liveness: 'assume-alive', reclaimStale: true })
  check('live holder survives reconciliation (DR-07)', live !== null && existsSync(livePath), `probe=${JSON.stringify(live)}; probePidLock in src/substrate/pidLock.ts must keep and return a lock whose holder is alive`)
}

section('§6 WIRING (DR-08)')
{
  const { crewChecks } = await import('../../src/services/health/sections/crew.ts')
  const { pidLockReleaseHealth: releasesNow } = await import('../../src/substrate/pidLock.ts')
  const lockSays = await crewChecks().find(row => row.id === 'pid-lock-release')?.run()
  const lockHealth = releasesNow()
  check(
    '/health carries the pid-lock-release row reading the health accessor',
    lockSays !== undefined && (lockHealth.notRemoved.count > 0 ? lockSays.status === 'warn' && lockSays.evidence.startsWith(`${lockHealth.notRemoved.count} lock release(s) settled`) : lockSays.status === 'ok' && lockSays.evidence === (lockHealth.retriedSuccesses.count > 0 ? `releases healthy (${lockHealth.retriedSuccesses.count} saved by the bounded retry)` : 'releases healthy')),
    `${lockSays?.evidence}; the pid-lock-release row in src/services/health/sections/crew/appends.ts must read pidLockReleaseHealth and report warn when notRemoved.count > 0, else ok`,
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-pidlock-release: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-pidlock-release: all green')
