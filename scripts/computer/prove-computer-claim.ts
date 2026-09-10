#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, freshSignal, section } from './computerProofKit.ts'

const claim = await import('../../src/services/desktop/desktopClaim.ts')
const { acquirePidLock, releasePidLock, probePidLock } = await import('../../src/substrate/pidLock.ts')
const { desktopSnapshot } = await import('../../src/services/desktop/desktopSession.ts')

const DEAD_PID = 2147483000
const path = claim.desktopClaimPath()

async function settled(predicate: () => Promise<boolean>, attempts = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return predicate()
}

section('§1 the claim lives under the daemon directory of the config home')
{
  check("the file is 'desktop.lock' under MERCURY_DAEMON_DIR", claim.DESKTOP_CLAIM_FILE === 'desktop.lock' && path === join(process.env.MERCURY_DAEMON_DIR ?? '', 'desktop.lock'), path)
  check('the idle release is thirty seconds', claim.DESKTOP_CLAIM_IDLE_RELEASE_MS === 30_000)
  check('nothing is held before the first act', claim.desktopClaimHeld() === false && desktopSnapshot().phase === 'idle')
}

section('§2 the first act claims, later acts adopt, the release frees')
{
  const first = await claim.claimDesktop(freshSignal())
  check('the claim wins on an empty home', first.held === true, JSON.stringify(first))
  check('desktopClaimHeld() reads true and the snapshot drives', claim.desktopClaimHeld() === true && desktopSnapshot().phase === 'driving')
  const holder = await claim.probeDesktopLock()
  check('the probe names this process', holder?.pid === process.pid, JSON.stringify(holder))
  const again = await claim.claimDesktop(freshSignal())
  check('a later act adopts its own record', again.held === true, JSON.stringify(again))
  await claim.releaseDesktopClaim()
  check('the release frees the desktop: nothing held, the snapshot idle, the probe empty', claim.desktopClaimHeld() === false && desktopSnapshot().phase === 'idle' && (await claim.probeDesktopLock()) === null)
}

section('§3 another session holding the desktop is refused by name')
{
  const foreign = await acquirePidLock(path, 'other-session:proof', { liveness: 'assume-dead' })
  check('a foreign owner takes the lock file', foreign.held === true, JSON.stringify(foreign))
  const refused = await claim.claimDesktop(freshSignal())
  check('the claim answers held false with the holder', refused.held === false && refused.holder?.pid === process.pid && refused.holder.owner === 'other-session:proof', JSON.stringify(refused))
  const note = claim.desktopClaimBusyNote(refused.held === false ? refused.holder : null)
  check('the busy note names the pid and an age and says one driver at a time', note.includes(String(process.pid)) && /since|ago|for \d/.test(note) && note.includes('one driver at a time'), note)
  check('nothing is held on this side', claim.desktopClaimHeld() === false && desktopSnapshot().phase === 'idle')
  const empty = claim.desktopClaimBusyNote(null)
  check('the note without a holder still refuses plainly', empty.length > 0 && !empty.includes('undefined'))
  await releasePidLock(path, 'other-session:proof')
}

section('§4 a dead holder is reclaimed')
{
  const planted = await acquirePidLock(path, 'dead-session:proof', { liveness: 'assume-dead' })
  check('a record is planted', planted.held === true)
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  delete record.procStart
  writeFileSync(path, JSON.stringify({ ...record, pid: DEAD_PID, acquiredAt: Date.now() - 60_000 }))
  const probed = await probePidLock(path, { liveness: 'assume-dead' })
  check('the dead pid probes as no holder', probed === null, JSON.stringify(probed))
  const reclaimed = await claim.claimDesktop(freshSignal())
  check('the claim wins over the dead record', reclaimed.held === true && claim.desktopClaimHeld() === true, JSON.stringify(reclaimed))
  await claim.releaseDesktopClaim()
}

section('§5 the abort listener releases')
{
  const controller = new AbortController()
  const taken = await claim.claimDesktop(controller.signal)
  check('held under the signal', taken.held === true && claim.desktopClaimHeld() === true)
  controller.abort()
  const released = await settled(async () => claim.desktopClaimHeld() === false && (await claim.probeDesktopLock()) === null && desktopSnapshot().phase === 'idle')
  check('the abort releases the claim: nothing held, the record gone, the snapshot idle', released)
}

section('§6 the idle timer re-arms per act and its body releases')
{
  const taken = await claim.claimDesktop(freshSignal())
  check('held again', taken.held === true)
  claim.renewDesktopClaim()
  check('renew keeps it held', claim.desktopClaimHeld() === true)
  await claim.releaseDesktopClaimForIdle()
  check('the idle release frees the desktop', claim.desktopClaimHeld() === false && desktopSnapshot().phase === 'idle' && (await claim.probeDesktopLock()) === null)
  check('the lock file is gone or empty after the release', !existsSync(path) || readFileSync(path, 'utf8').trim() === '')
}

finish('prove-computer-claim')
