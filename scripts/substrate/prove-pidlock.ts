// prove-pidlock — the ONE pid-liveness mutex (HANDOFF-REACTIVE-SUBSTRATE Phase 1).
//
//   §1 fresh acquire · blocked-by-live-holder (a real sleeping child pid)
//   §2 stale reclaim: dead-pid holder is reclaimed exactly once
//   §3 same-owner adopt: identity persists across a "new pid" (--resume pattern)
//   §4 release only releases our own record
//   §5 unparseable holder is treated as stale
//   §6 the reuse guard on EVERY platform: a recorded start token that the
//      live pid no longer carries is a recycled pid ⇒ reclaimed; a matching
//      token ⇒ blocked; a gone/unknown live token keeps the fail-safe polarity
//      (TASK-017 S2, pidlock-reuse-guard-inert-on-win32)
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

const tmp = mkdtempSync(join(tmpdir(), 'hermes-pidlock-'))
const L = (name: string) => join(tmp, name)

// ── §1 fresh acquire + blocked by a LIVE holder ─────────────────────────────
{
  const a = await acquirePidLock(L('a.lock'), 'owner-a', { liveness: 'assume-dead' })
  ok(a.held && a.fresh, '§1 fresh acquire succeeds')
  // A live child holds a lock; another owner must be BLOCKED.
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

// ── §2 stale reclaim (dead pid) ─────────────────────────────────────────────
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

// ── §3 same-owner adopt (the --resume new-pid pattern) ──────────────────────
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

// ── §4 release only our own ─────────────────────────────────────────────────
{
  await acquirePidLock(L('rel.lock'), 'owner-r', { liveness: 'assume-dead' })
  await releasePidLock(L('rel.lock'), 'someone-else')
  ok(existsSync(L('rel.lock')), '§4 release with wrong owner is a no-op')
  await releasePidLock(L('rel.lock'), 'owner-r')
  ok(!existsSync(L('rel.lock')), '§4 release with the owning identity unlinks')
}

// ── §5 unparseable holder = stale ───────────────────────────────────────────
{
  writeFileSync(L('junk.lock'), 'not json{{')
  const got = await acquirePidLock(L('junk.lock'), 'owner-j', { liveness: 'assume-alive' })
  ok(got.held, '§5 unparseable holder treated as stale and reclaimed')
}

// ── §6 the reuse guard on every platform (injected live tokens) ────────────
{
  // A REAL live pid (this process) so the kill(pid,0) half passes on every
  // platform; the live TOKEN is injected exactly as the async callers
  // pre-fetch it, so the verdict is driven pure — no CIM, no ps here.
  const recorded = { owner: 'recorded', pid: process.pid, acquiredAt: Date.now(), procStart: 'token-A' }
  ok(holderAlive(recorded, 'assume-alive', 'token-A') === true, '§6 the same token ⇒ the recorded process still owns the pid (blocked)')
  ok(holderAlive(recorded, 'assume-alive', 'token-B') === false, '§6 a DIFFERENT token ⇒ the pid was recycled ⇒ dead (reclaimable) — the guard that was linux-only')
  ok(holderAlive(recorded, 'assume-alive', '') === false, "§6 a GONE answer ('') ⇒ dead")
  ok(holderAlive(recorded, 'assume-alive', null) === true, '§6 an unknowable token (null) ⇒ alive (never a death verdict from a probe glitch)')
  const tokenless = { owner: 'legacy', pid: process.pid, acquiredAt: Date.now() }
  ok(holderAlive(tokenless, 'assume-alive', 'token-B') === true, '§6 a record WITHOUT a token keeps pid-only liveness (pre-token records unchanged)')
  // The record now carries a token on THIS platform too (the acquire path
  // records linux /proc or the cross-platform owner's probe).
  const mine = await acquirePidLock(L('tok.lock'), 'owner-t', { liveness: 'assume-alive' })
  const raw = JSON.parse(readFileSync(L('tok.lock'), 'utf8')) as { procStart?: string }
  ok(mine.held && typeof raw.procStart === 'string' && raw.procStart.length > 0, '§6 acquire records a procStart token on this platform (was linux-only)')
  // A forged record naming OUR pid with a WRONG token is reclaimed by a
  // second owner: the live probe (ps lstart here) disagrees with the record.
  writeFileSync(L('recycled.lock'), JSON.stringify({ owner: 'ghost', pid: process.pid, acquiredAt: Date.now() - 60_000, procStart: 'not-our-start-time' }))
  const reclaimed = await acquirePidLock(L('recycled.lock'), 'owner-u', { liveness: 'assume-alive' })
  ok(reclaimed.held === true, '§6 a live pid whose recorded token mismatches the LIVE token is reclaimed end to end (the async pre-fetch through the one owner)')
}
rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`prove-pidlock: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-pidlock: ALL GREEN')
