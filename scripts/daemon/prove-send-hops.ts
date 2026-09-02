#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-send-hops.ts — FN-020 row 10: the Enter-to-echo path
//  loses its per-send disk reads and handshakes.
//
//  The class, serialized in the connector's deliver() on every Enter: an
//  awaited obligations-store read BEFORE the operator's echo row painted; a
//  fresh hello handshake RPC (connect · frame · reply) even mid-conversation;
//  and the auth-stamped sessionDispatch re-reading the control-key file
//  per call. Now: the echo paints first and re-keys if the words answer an
//  open question; a daemon that answered usable moments ago is usable now
//  (a 5 s memo the transport's own ENOCONN stamp clears); the control key is
//  read once and kept, an EAUTH refusal re-reads it and re-sends once when
//  the key on disk actually moved.
//
//    S1  the key memo: three stamped ops read the key file ONCE
//    S2  rotation: a stale key comes back EAUTH → re-read → one re-send,
//        the op succeeds; the next op hits the memo again
//    S3  a genuinely refused key: no key movement ⇒ no re-send, EAUTH
//        surfaces
//    S4  the usable-daemon memo: four ensures cost ONE hello
//    S5  the daemon gone: an ENOCONN reply stamps the transport and the
//        memo stands down (no spawn is attempted here)
//    S6  the echo paints before the obligations read (source pins on
//        deliver(): set + paint precede the await; the re-key branch)
//    S7  wiring — the EAUTH branch, the memo roads, the registry rows
//
//  A fake control server on a scratch daemon dir stands in for the daemon:
//  it echoes the client's own version facts on `hello` (a matched verdict)
//  and checks the auth stamp on keyed ops. Operation-shaped throughout.
// ============================================================================
import { createServer, type Socket } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'send-hops-home-'))
const daemonDirPath = mkdtempSync(join(tmpdir(), 'send-hops-daemon-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDirPath
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const cs = await import('../../src/daemon/controlSocket.ts')
const ensure = await import('../../src/services/switchboard/ensureDaemon.ts')
const census = cs.controlSocketCensus
const resetCensus = (): void => {
  census.keyReads = 0
  census.keyMemoHits = 0
  census.eauthRetries = 0
}

// ── the fake daemon ─────────────────────────────────────────────────────────
mkdirSync(daemonDirPath, { recursive: true })
let serverKey = 'key-A'
writeFileSync(cs.controlKeyPath(), `${serverKey}\n`, { mode: 0o600 })
let hellos = 0
let connections = 0
const server = createServer((sock: Socket) => {
  connections++
  let pending = ''
  sock.on('data', chunk => {
    pending += chunk.toString('utf8')
    const nl = pending.indexOf('\n')
    if (nl < 0) return
    const req = JSON.parse(pending.slice(0, nl)) as Record<string, unknown>
    let reply: Record<string, unknown>
    if (req.op === 'hello') {
      hellos++
      reply = {
        ok: true,
        op: 'hello',
        proto: req.proto,
        minProto: req.proto,
        ready: true,
        version: req.clientVersion,
        buildTree: req.clientBuildTree ?? null,
        pid: 4242,
        startedAt: Date.now(),
        ownerPid: null,
        foreground: false,
        live: 0,
        liveSessions: 0,
        warm: 0,
        restartArmed: false,
      }
    } else if (req.auth !== serverKey) {
      reply = { ok: false, code: 'EAUTH', error: `${String(req.op)} rejected: this client didn't present the daemon control key` }
    } else {
      reply = { ok: true, op: req.op }
    }
    sock.write(`${JSON.stringify(reply)}\n`)
    sock.end()
  })
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(cs.controlSockPath(), () => resolve())
})
const stamped = (): Promise<{ ok: boolean; code?: string }> => cs.daemonControlRpc({ op: 'status' } as never, { timeoutMs: 2000 }) as never

section('S1 the key memo — three stamped ops read the key file ONCE')
{
  resetCensus()
  const replies = [await stamped(), await stamped(), await stamped()]
  check('all three ops succeeded', replies.every(r => r.ok === true), JSON.stringify(replies))
  check('one key-file read, two memo hits (was one read per op)', census.keyReads === 1 && census.keyMemoHits === 2, JSON.stringify(census))
  console.log('  BEFORE: 1 control-key file read per auth-stamped op (every Enter) · AFTER: 1 per process, then memory')
}

section('S2 rotation — a stale key comes back EAUTH, is re-read, and the op is re-sent once')
{
  serverKey = 'key-B'
  writeFileSync(cs.controlKeyPath(), `${serverKey}\n`, { mode: 0o600 })
  resetCensus()
  const r = await stamped()
  check('the op succeeded through the re-send', r.ok === true, JSON.stringify(r))
  check('exactly one re-read and one re-send', census.keyReads === 1 && census.eauthRetries === 1, JSON.stringify(census))
  const again = await stamped()
  // Two memo hits by now: the stale hit that earned the EAUTH, then the
  // rotated key's hit; still the one re-read.
  check('the next op hits the memo with the rotated key (no further read)', again.ok === true && census.keyMemoHits === 2 && census.keyReads === 1, JSON.stringify(census))
}

section('S3 a genuinely refused key — no movement on disk, no re-send, EAUTH surfaces')
{
  serverKey = 'key-C'
  resetCensus()
  const r = await stamped()
  check('the refusal surfaces as EAUTH', r.ok === false && r.code === 'EAUTH', JSON.stringify(r))
  check('the key was re-read once and, unchanged, never re-sent', census.keyReads === 1 && census.eauthRetries === 0, JSON.stringify(census))
  serverKey = 'key-B'
}

section('S4 the usable-daemon memo — four ensures cost ONE hello')
{
  ensure._resetDaemonUsableMemoForProofs()
  hellos = 0
  const first = await ensure.ensureOwnedDaemon()
  check('the first ensure handshakes (one hello) and finds the daemon usable', first === true && hellos === 1, `hellos=${hellos} first=${String(first)}`)
  check('the memo is active after a usable verdict', ensure._daemonUsableMemoActiveForProofs() === true)
  const more = [await ensure.ensureOwnedDaemon(), await ensure.ensureOwnedDaemon(), await ensure.ensureOwnedDaemon()]
  check('three more ensures inside the window cost no hello (was one RPC per send)', more.every(v => v === true) && hellos === 1, `hellos=${hellos}`)
  console.log('  BEFORE: 1 hello handshake RPC (connect · frame · reply) per send · AFTER: 1 per 5 s window while the daemon answers')
}

section('S5 the daemon gone — an ENOCONN reply stamps the transport; the memo stands down')
{
  const before = cs.daemonLastUnreachableAt()
  await new Promise<void>(resolve => server.close(() => resolve()))
  const r = await stamped()
  check('with no daemon the stamped op comes back ENOCONN', r.ok === false && r.code === 'ENOCONN', JSON.stringify(r))
  check('the transport stamped the moment', cs.daemonLastUnreachableAt() > before && cs.daemonLastUnreachableAt() > 0)
  check('the usable-daemon memo no longer answers (the next ensure would handshake and heal)', ensure._daemonUsableMemoActiveForProofs() === false)
}

section('S6 the echo paints before the obligations read (deliver)')
{
  const src = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  const at = src.indexOf('  private async deliver(')
  const body = at >= 0 ? src.slice(at, at + 6000) : ''
  const setAt = body.indexOf('this.echoRows.set(provisionalId,')
  const paintAt = body.indexOf('this.paint()', setAt)
  const readAt = body.indexOf('const answering = await this.openQuestion()')
  check('the echo row is set and painted BEFORE the obligations read', setAt > 0 && paintAt > setAt && readAt > paintAt, `${setAt},${paintAt},${readAt}`)
  check('a held/failed resend of the same words keeps its id (minted before the read)', /const provisionalId =\n\s*this\.retainedSend !== null && this\.retainedSend\.text === expanded \? this\.retainedSend\.id : randomUUID\(\)/.test(body))
  check('the answering case re-keys the row in place', /const clientMessageId = answering !== null \? `obl-answer:\$\{answering\}` : provisionalId\n\s*if \(clientMessageId !== provisionalId\) \{[\s\S]{0,500}?this\.echoRows\.set\(key === provisionalId \? clientMessageId : key, row\)/.test(body))
  check('no obligations read precedes the paint', body.indexOf('await this.openQuestion()') > paintAt)
  console.log('  BEFORE: the echo row waited on an obligations-store file read + parse · AFTER: it paints at entry; the read follows')
}

section('S7 wiring')
{
  const sock = readFileSync(join(ROOT, 'src/daemon/controlSocket.ts'), 'utf8')
  check('stamped ops take the key from the memo; a missing key is never memoized', /const key = await controlKeyForStamp\(\)/.test(sock) && /if \(key !== null\) controlKeyMemo = key/.test(sock))
  check('EAUTH clears the memo, re-reads, and re-sends once only when the key moved', /reply\.code === 'EAUTH'\) \{[\s\S]{0,400}?clearControlKeyMemo\(\)[\s\S]{0,200}?if \(fresh !== null && fresh !== stale\) \{[\s\S]{0,200}?reply = await rpcOnce\(sessionOpWireFrame\(outbound\), timeoutMs\)/.test(sock))
  check('ENOCONN stamps the transport on both sends', (sock.match(/if \(!reply\.ok && reply\.code === 'ENOCONN'\) lastUnreachableAt = Date\.now\(\)/g) ?? []).length === 2)
  const ens = readFileSync(join(ROOT, 'src/services/switchboard/ensureDaemon.ts'), 'utf8')
  check('the memo answers first, except under the /halt stand-down', /if \(usableMemoActive\(\) && !daemonHaltStanddownActive\(\)\) return true\n\s*const hs = await import/.test(ens))
  check('the memo stands only inside the TTL and while no ENOCONN is newer than it', /now - usableMemo\.at < USABLE_MEMO_TTL_MS && daemonLastUnreachableAt\(\) < usableMemo\.at/.test(ens) && ens.includes('const USABLE_MEMO_TTL_MS = 5_000'))
  check('every usable road remembers (matched, healed-serving, successor, awaited)', (ens.match(/return rememberUsable\(\)/g) ?? []).length >= 5)
  const registry = readFileSync(join(ROOT, 'scripts/staleness/prove-stale-registry.ts'), 'utf8')
  check('both memos carry their stale-registry rows', registry.includes('src/daemon/controlSocket.ts :: controlKeyMemo :: invalidator=clearControlKeyMemo') && registry.includes('src/services/switchboard/ensureDaemon.ts :: usableMemo :: ttl-bounded'))
}

console.log(failures === 0 ? '\n✅ ALL SEND-HOPS PROOFS PASS' : `\n❌ ${failures} SEND-HOPS PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
