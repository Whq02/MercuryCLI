#!/usr/bin/env bun
import { createServer, type Socket } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

const cs = await import('../../src/daemon/control/controlSocket.ts')
const ensure = await import('../../src/daemon/switchboard/ensureDaemon.ts')
const census = cs.controlSocketCensus
const resetCensus = (): void => {
  census.keyReads = 0
  census.keyMemoHits = 0
  census.eauthRetries = 0
}

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
  check('all three ops succeeded', replies.every(r => r.ok === true), `${JSON.stringify(replies)}; daemonControlRpc in src/daemon/control/controlSocket.ts must stamp the control key from controlKeyPath() on each op`)
  check('one key-file read, two memo hits (was one read per op)', census.keyReads === 1 && census.keyMemoHits === 2, `${JSON.stringify(census)}; the control-key read in src/daemon/control/controlSocket.ts must memoize the key after its first read (keyReads 1, keyMemoHits 2)`)
  console.log('  BEFORE: 1 control-key file read per auth-stamped op (every Enter) · AFTER: 1 per process, then memory')
}

section('S2 rotation — a stale key comes back EAUTH, is re-read, and the op is re-sent once')
{
  serverKey = 'key-B'
  writeFileSync(cs.controlKeyPath(), `${serverKey}\n`, { mode: 0o600 })
  resetCensus()
  const r = await stamped()
  check('the op succeeded through the re-send', r.ok === true, `${JSON.stringify(r)}; daemonControlRpc in src/daemon/control/controlSocket.ts must re-read the key file on EAUTH and re-send the op once`)
  check('exactly one re-read and one re-send', census.keyReads === 1 && census.eauthRetries === 1, `${JSON.stringify(census)}; daemonControlRpc in src/daemon/control/controlSocket.ts must do exactly one re-read and one re-send per EAUTH`)
  const again = await stamped()
  check('the next op hits the memo with the rotated key (no further read)', again.ok === true && census.keyMemoHits === 2 && census.keyReads === 1, `${JSON.stringify(census)}; src/daemon/control/controlSocket.ts must keep the rotated key in its memo after a re-read`)
}

section('S3 a genuinely refused key — no movement on disk, no re-send, EAUTH surfaces')
{
  serverKey = 'key-C'
  resetCensus()
  const r = await stamped()
  check('the refusal surfaces as EAUTH', r.ok === false && r.code === 'EAUTH', `${JSON.stringify(r)}; daemonControlRpc in src/daemon/control/controlSocket.ts must return the EAUTH reply when the re-read key is unchanged`)
  check('the key was re-read once and, unchanged, never re-sent', census.keyReads === 1 && census.eauthRetries === 0, `${JSON.stringify(census)}; daemonControlRpc in src/daemon/control/controlSocket.ts must not re-send when the re-read key equals the one it sent`)
  serverKey = 'key-B'
}

section('S4 the usable-daemon memo — four ensures cost ONE hello')
{
  ensure._resetDaemonUsableMemoForProofs()
  hellos = 0
  const first = await ensure.ensureOwnedDaemon()
  check('the first ensure handshakes (one hello) and finds the daemon usable', first === true && hellos === 1, `hellos=${hellos} first=${String(first)}; ensureOwnedDaemon in src/daemon/switchboard/ensureDaemon.ts must do one hello and report the daemon usable`)
  check('the memo is active after a usable verdict', ensure._daemonUsableMemoActiveForProofs() === true, 'ensureOwnedDaemon in src/daemon/switchboard/ensureDaemon.ts must set its usable-daemon memo after a usable verdict')
  const more = [await ensure.ensureOwnedDaemon(), await ensure.ensureOwnedDaemon(), await ensure.ensureOwnedDaemon()]
  check('three more ensures inside the window cost no hello (was one RPC per send)', more.every(v => v === true) && hellos === 1, `hellos=${hellos}; ensureOwnedDaemon in src/daemon/switchboard/ensureDaemon.ts must answer from its usable-daemon memo inside the window without a hello`)
  console.log('  BEFORE: 1 hello handshake RPC (connect · frame · reply) per send · AFTER: 1 per 5 s window while the daemon answers')
}

section('S5 the daemon gone — an ENOCONN reply stamps the transport; the memo stands down')
{
  const before = cs.daemonLastUnreachableAt()
  await new Promise<void>(resolve => server.close(() => resolve()))
  const r = await stamped()
  check('with no daemon the stamped op comes back ENOCONN', r.ok === false && r.code === 'ENOCONN', `${JSON.stringify(r)}; daemonControlRpc in src/daemon/control/controlSocket.ts must return code ENOCONN when the socket cannot be reached`)
  check('the transport stamped the moment', cs.daemonLastUnreachableAt() > before && cs.daemonLastUnreachableAt() > 0, 'daemonControlRpc in src/daemon/control/controlSocket.ts must set lastUnreachableAt (read by daemonLastUnreachableAt) on an ENOCONN reply')
  check('the usable-daemon memo no longer answers (the next ensure would handshake and heal)', ensure._daemonUsableMemoActiveForProofs() === false, 'the usable-daemon memo in src/daemon/switchboard/ensureDaemon.ts must stand down once daemonLastUnreachableAt in src/daemon/control/controlSocket.ts moves')
}


console.log(failures === 0 ? '\n✅ ALL SEND-HOPS PROOFS PASS' : `\n❌ ${failures} SEND-HOPS PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
