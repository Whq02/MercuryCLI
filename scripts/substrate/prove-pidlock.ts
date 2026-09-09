import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  acquirePidLock,
  releasePidLock,
  probePidLock,
  holderAlive,
} from '../../src/substrate/pidLock.ts'

let failures = 0
const ok = (cond: boolean, label: string, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${cond || detail === '' ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const tmp = mkdtempSync(join(tmpdir(), 'mercury-pidlock-'))
const L = (name: string) => join(tmp, name)

{
  const a = await acquirePidLock(L('a.lock'), 'owner-a', { liveness: 'assume-dead' })
  ok(a.held && a.fresh, '§1 fresh acquire succeeds')
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(
    L('live.lock'),
    JSON.stringify({ owner: 'other', pid: child.pid, acquiredAt: Date.now() }),
  )
  const b = await acquirePidLock(L('live.lock'), 'owner-b', { liveness: 'assume-dead' })
  ok(!b.held && b.by?.pid === child.pid, '§1 blocked by a live holder (real child pid)')
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
  ok(got.held, '§2 dead-pid holder reclaimed')
  const probe = await probePidLock(L('stale.lock'), { liveness: 'assume-dead' })
  ok(probe?.owner === 'owner-c', '§2 probe shows the reclaimer as the live holder', `platform=${process.platform} probe=${JSON.stringify(probe)}`)
}

{
  writeFileSync(
    L('adopt.lock'),
    JSON.stringify({ owner: 'me', pid: 99999999, acquiredAt: Date.now() }),
  )
  const got = await acquirePidLock(L('adopt.lock'), 'me', { liveness: 'assume-dead' })
  ok(got.held && !got.fresh, '§3 same-owner re-acquire adopts (fresh=false)')
  const probe = await probePidLock(L('adopt.lock'), { liveness: 'assume-dead' })
  ok(probe?.pid === process.pid, '§3 adopted record re-stamped with our pid', `platform=${process.platform} probe=${JSON.stringify(probe)}`)
}

{
  await acquirePidLock(L('rel.lock'), 'owner-r', { liveness: 'assume-dead' })
  await releasePidLock(L('rel.lock'), 'someone-else')
  ok(existsSync(L('rel.lock')), '§4 release with wrong owner is a no-op')
  await releasePidLock(L('rel.lock'), 'owner-r')
  ok(!existsSync(L('rel.lock')), '§4 release with the owning identity unlinks')
}

{
  writeFileSync(L('junk.lock'), 'not json{{')
  const got = await acquirePidLock(L('junk.lock'), 'owner-j', { liveness: 'assume-alive' })
  ok(got.held, '§5 unparseable holder treated as stale and reclaimed')
}

{
  const recorded = { owner: 'recorded', pid: process.pid, acquiredAt: Date.now(), procStart: 'token-A' }
  ok(holderAlive(recorded, 'assume-alive', 'token-A') === true, '§6 the same token ⇒ the recorded process still owns the pid (blocked)')
  ok(holderAlive(recorded, 'assume-alive', 'token-B') === false, '§6 a DIFFERENT token ⇒ the pid was recycled ⇒ dead (reclaimable) — the guard that was linux-only')
  ok(holderAlive(recorded, 'assume-alive', '') === false, "§6 a GONE answer ('') ⇒ dead")
  ok(holderAlive(recorded, 'assume-alive', null) === true, '§6 an unknowable token (null) ⇒ alive (never a death verdict from a probe glitch)')
  const tokenless = { owner: 'legacy', pid: process.pid, acquiredAt: Date.now() }
  ok(holderAlive(tokenless, 'assume-alive', 'token-B') === true, '§6 a record WITHOUT a token keeps pid-only liveness (pre-token records unchanged)')
  const mine = await acquirePidLock(L('tok.lock'), 'owner-t', { liveness: 'assume-alive' })
  const raw = JSON.parse(readFileSync(L('tok.lock'), 'utf8')) as { procStart?: string }
  ok(mine.held && typeof raw.procStart === 'string' && raw.procStart.length > 0, '§6 acquire records a procStart token on this platform (was linux-only)')
  writeFileSync(L('recycled.lock'), JSON.stringify({ owner: 'ghost', pid: process.pid, acquiredAt: Date.now() - 60_000, procStart: 'not-our-start-time' }))
  const reclaimed = await acquirePidLock(L('recycled.lock'), 'owner-u', { liveness: 'assume-alive' })
  ok(reclaimed.held === true, '§6 a live pid whose recorded token mismatches the LIVE token is reclaimed end to end (the async pre-fetch through the one owner)')
}

{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'substrate', 'pidLock.ts'), 'utf8')
  const fn = src.slice(src.indexOf('async function liveTokenFor('), src.indexOf('export interface PidLockHolder'))
  ok(/\/\^\\d\+\$\/\.test\(holder\.procStart\)/.test(fn) && fn.includes('procStartToken(holder.pid)'), '§7 liveTokenFor reads a digits record through /proc first (the record\'s own vocabulary)')
  ok(/return probed === '' \? '' : null/.test(fn), "§7 a ps token against a /proc record is unknowable (null ⇒ alive), a gone answer ('') stays gone")
  writeFileSync(L('digits.lock'), JSON.stringify({ owner: 'ghost', pid: process.pid, acquiredAt: Date.now() - 60_000, procStart: '424242' }))
  const digits = await acquirePidLock(L('digits.lock'), 'owner-v', { liveness: 'assume-alive' })
  if (process.platform === 'linux') {
    ok(digits.held === true, '§7 linux: a /proc-vocabulary record naming our pid with a WRONG start time is reclaimed (the compare reads /proc)')
  } else {
    ok(digits.held === false, '§7 no /proc here: a /proc-vocabulary record cannot be compared with a ps token ⇒ alive ⇒ blocked (never a death verdict across vocabularies)')
  }
}
rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`prove-pidlock: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-pidlock: ALL GREEN')
