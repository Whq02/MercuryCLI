#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/muster-fixture-daemon.ts — the journey's FIXTURE
//  control daemon. Speaks the real newline-framed control-socket protocol
//  (ping · reconfigure · list) with ZERO spawned children and ZERO paid calls:
//  a reconfigure ACKs respawned:true and flips the fixture's "running"
//  implementer spec, so the next `list` reports the retarget as applied —
//  exactly the observable chain the receipt engine watches. Every request is
//  appended to MUSTER_FIXTURE_LOG (JSONL) as the journey's wire evidence.
//
//  Env: MERCURY_DAEMON_DIR (required) — where supervisor.json + control.key +
//  control.sock land (same formulas as controlSocket.ts for short paths);
//  MUSTER_FIXTURE_LOG (required) — the request log.
// ============================================================================
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.MERCURY_DAEMON_DIR
const logPath = process.env.MUSTER_FIXTURE_LOG
if (!dir || !logPath) {
  console.error('muster-fixture-daemon: MERCURY_DAEMON_DIR + MUSTER_FIXTURE_LOG required')
  process.exit(2)
}
mkdirSync(dir, { recursive: true })
// MIRROR controlSockPath() exactly (client and fixture must agree): AF_UNIX
// sun_path is ~104 bytes on darwin — past the safe bound the real client
// resolves a hashed tmpdir socket, so a deep temp dir would otherwise bind
// here while the client dials the hash (or fail to bind at all).
const SUN_PATH_SAFE_MAX = 100
const preferred = join(dir, 'control.sock')
const sockPath =
  Buffer.byteLength(preferred, 'utf8') <= SUN_PATH_SAFE_MAX
    ? preferred
    : join(tmpdir(), `hermes-daemon-${createHash('sha1').update(dir).digest('hex').slice(0, 12)}.sock`)

// The fixture's "roster truth": what the pretend implementer child runs —
// seeded with the CURRENT implementer seat default (seatSlots.ts, D-02a);
// the journey reslots it to sonnet-5 and watches the flip apply.
const running = { model: 'claude-opus-5', effort: 'max' }
const startedAt = Date.now()

writeFileSync(join(dir, 'control.key'), 'f'.repeat(64), { mode: 0o600 })
writeFileSync(
  join(dir, 'supervisor.json'),
  JSON.stringify(
    {
      pid: process.pid,
      version: '1.1.0-muster-fixture',
      origin: 'transient',
      startedAt,
      dir: process.cwd(),
      controlSock: sockPath,
    },
    null,
    2,
  ),
)

function log(entry: Record<string, unknown>): void {
  appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...entry }) + '\n')
}

const server = net.createServer(sock => {
  let buf = ''
  sock.on('data', chunk => {
    buf += chunk.toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl)
    let req: Record<string, unknown>
    try {
      req = JSON.parse(line) as Record<string, unknown>
    } catch {
      sock.end(JSON.stringify({ ok: false, code: 'EUNKNOWN', error: 'bad frame' }) + '\n')
      return
    }
    log({ req })
    const op = req.op
    let reply: Record<string, unknown>
    if (op === 'ping') {
      reply = { ok: true, op: 'ping', version: '1.1.0-muster-fixture', proto: req.proto ?? 4 }
    } else if (op === 'reconfigure') {
      if (typeof req.model === 'string' && req.model) running.model = req.model
      if (typeof req.effort === 'string' && req.effort) running.effort = req.effort
      reply = { ok: true, op: 'reconfigure', respawned: true, pending: false }
    } else if (op === 'list') {
      reply = {
        ok: true,
        op: 'list',
        jobs: [
          {
            short: 'implementer',
            sessionId: 'fx-implementer',
            prompt: '',
            source: 'scribe',
            state: 'running',
            pid: process.pid,
            startedAt,
            cliVersion: '1.1.0-muster-fixture',
            model: running.model,
            effort: running.effort,
            respawns: 0,
            busy: false,
          },
        ],
      }
    } else {
      reply = { ok: false, code: 'EUNSUPPORTED', error: `fixture: unhandled op ${String(op)}` }
    }
    sock.end(JSON.stringify(reply) + '\n')
  })
})
server.listen(sockPath, () => {
  log({ event: 'listening', sockPath })
  // eslint-disable-next-line no-console
  console.error(`[muster-fixture] listening at ${sockPath}`)
})
