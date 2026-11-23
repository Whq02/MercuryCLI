import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  acquirePidLock,
  releasePidLock,
  probePidLock,
  holderAlive,
} from '../../src/platform/substrate/pidLock.ts'

let failures = 0
const ok = (cond: boolean, label: string, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${cond || detail === '' ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-pidlock-'))
const L = (name: string) => join(tmp, name)

{
  const a = await acquirePidLock(L('a.lock'), 'owner-a', { liveness: 'assume-dead' })
  ok(a.held && a.fresh, '§1 fresh acquire succeeds', `got ${JSON.stringify(a)}; acquirePidLock in src/platform/substrate/pidLock.ts must take a lock file that does not exist`)
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(
    L('live.lock'),
    JSON.stringify({ owner: 'other', pid: child.pid, acquiredAt: Date.now() }),
  )
  const b = await acquirePidLock(L('live.lock'), 'owner-b', { liveness: 'assume-dead' })
  ok(!b.held && b.by?.pid === child.pid, '§1 blocked by a live holder (real child pid)', `got ${JSON.stringify(b)}; acquirePidLock in src/platform/substrate/pidLock.ts must refuse while holderAlive says the recorded pid is alive`)
  child.kill('SIGKILL')
  await new Promise<void>(r => child.on('exit', () => r()))
}

{
  const child = spawn('sleep', ['0.01'], { stdio: 'ignore' })
  const deadPid = child.pid!
  await new Promise<void>(r => child.on('exit', () => r()))
  writeFileSync(
    L('stale.lock'),
    JSON.stringify({ owner: 'ghost', pid: deadPid, acquiredAt: Date.now() - 60000 }),
  )
  const got = await acquirePidLock(L('stale.lock'), 'owner-c', { liveness: 'assume-dead' })
  ok(got.held, '§2 dead-pid holder reclaimed', `got ${JSON.stringify(got)}; acquirePidLock in src/platform/substrate/pidLock.ts must reclaim a lock whose recorded pid is dead`)
  const probe = await probePidLock(L('stale.lock'), { liveness: 'assume-dead' })
  ok(probe?.owner === 'owner-c', '§2 probe shows the reclaimer as the live holder', `platform=${process.platform} probe=${JSON.stringify(probe)}`)
}

{
  writeFileSync(
    L('adopt.lock'),
    JSON.stringify({ owner: 'me', pid: 99999999, acquiredAt: Date.now() }),
  )
  const got = await acquirePidLock(L('adopt.lock'), 'me', { liveness: 'assume-dead' })
  ok(got.held && !got.fresh, '§3 same-owner re-acquire adopts (fresh=false)', `got ${JSON.stringify(got)}; acquirePidLock in src/platform/substrate/pidLock.ts must adopt a record whose owner is the caller, with fresh=false`)
  const probe = await probePidLock(L('adopt.lock'), { liveness: 'assume-dead' })
  ok(probe?.pid === process.pid, '§3 adopted record re-stamped with our pid', `platform=${process.platform} probe=${JSON.stringify(probe)}`)
}

{
  await acquirePidLock(L('rel.lock'), 'owner-r', { liveness: 'assume-dead' })
  await releasePidLock(L('rel.lock'), 'someone-else')
  ok(existsSync(L('rel.lock')), '§4 release with wrong owner is a no-op', 'releasePidLock in src/platform/substrate/pidLock.ts must not unlink a lock another owner holds')
  await releasePidLock(L('rel.lock'), 'owner-r')
  ok(!existsSync(L('rel.lock')), '§4 release with the owning identity unlinks', 'releasePidLock in src/platform/substrate/pidLock.ts must unlink the lock when the owner matches')
}

{
  writeFileSync(L('junk.lock'), 'not json{{')
  const got = await acquirePidLock(L('junk.lock'), 'owner-j', { liveness: 'assume-alive' })
  ok(got.held, '§5 unparseable holder treated as stale and reclaimed', `got ${JSON.stringify(got)}; acquirePidLock in src/platform/substrate/pidLock.ts must treat a lock file that is not valid JSON as stale`)
}

{
  const recorded = { owner: 'recorded', pid: process.pid, acquiredAt: Date.now(), procStart: 'token-A' }
  ok(holderAlive(recorded, 'assume-alive', 'token-A') === true, '§6 the same token ⇒ the recorded process still owns the pid (blocked)', 'holderAlive in src/platform/substrate/pidLock.ts must answer alive when the recorded procStart equals the live token')
  ok(holderAlive(recorded, 'assume-alive', 'token-B') === false, '§6 a DIFFERENT token ⇒ the pid was recycled ⇒ dead (reclaimable) — the guard that was linux-only', 'holderAlive in src/platform/substrate/pidLock.ts must answer dead when the live token differs from the recorded procStart')
  ok(holderAlive(recorded, 'assume-alive', '') === false, "§6 a GONE answer ('') ⇒ dead", "holderAlive in src/platform/substrate/pidLock.ts must answer dead when the live token is ''")
  ok(holderAlive(recorded, 'assume-alive', null) === true, '§6 an unknowable token (null) ⇒ alive (never a death verdict from a probe glitch)', 'holderAlive in src/platform/substrate/pidLock.ts must answer alive when the live token is null')
  const tokenless = { owner: 'legacy', pid: process.pid, acquiredAt: Date.now() }
  ok(holderAlive(tokenless, 'assume-alive', 'token-B') === true, '§6 a record WITHOUT a token keeps pid-only liveness (pre-token records unchanged)', 'holderAlive in src/platform/substrate/pidLock.ts must fall back to pid-only liveness when the record has no procStart')
  const mine = await acquirePidLock(L('tok.lock'), 'owner-t', { liveness: 'assume-alive' })
  const raw = JSON.parse(readFileSync(L('tok.lock'), 'utf8')) as { procStart?: string }
  ok(mine.held && typeof raw.procStart === 'string' && raw.procStart.length > 0, '§6 acquire records a procStart token on this platform (was linux-only)', `lock file procStart=${JSON.stringify(raw.procStart)}; acquirePidLock in src/platform/substrate/pidLock.ts must write a procStart token`)
  writeFileSync(L('recycled.lock'), JSON.stringify({ owner: 'ghost', pid: process.pid, acquiredAt: Date.now() - 60_000, procStart: 'not-our-start-time' }))
  const reclaimed = await acquirePidLock(L('recycled.lock'), 'owner-u', { liveness: 'assume-alive' })
  ok(reclaimed.held === true, '§6 a live pid whose recorded token mismatches the LIVE token is reclaimed end to end (the async pre-fetch through the one owner)', `got ${JSON.stringify(reclaimed)}; acquirePidLock in src/platform/substrate/pidLock.ts must reclaim a record whose procStart differs from the live token`)
}

{
  writeFileSync(L('digits.lock'), JSON.stringify({ owner: 'ghost', pid: process.pid, acquiredAt: Date.now() - 60_000, procStart: '424242' }))
  const digits = await acquirePidLock(L('digits.lock'), 'owner-v', { liveness: 'assume-alive' })
  if (process.platform === 'linux') {
    ok(digits.held === true, '§7 linux: a /proc-vocabulary record naming our pid with a WRONG start time is reclaimed (the compare reads /proc)', `got ${JSON.stringify(digits)}; holderAlive and acquirePidLock in src/platform/substrate/pidLock.ts must compare a /proc-vocabulary start time on linux`)
  } else {
    ok(digits.held === false, '§7 no /proc here: a /proc-vocabulary record cannot be compared with a ps token ⇒ alive ⇒ blocked (never a death verdict across vocabularies)', `got ${JSON.stringify(digits)}; holderAlive in src/platform/substrate/pidLock.ts must answer alive when the record and the live token use different vocabularies`)
  }
}
rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`prove-pidlock: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-pidlock: ALL GREEN')
