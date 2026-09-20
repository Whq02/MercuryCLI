#!/usr/bin/env bun
import net from 'node:net'
import { appendFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: process.env.DEPARTURE_FIXTURE_VERSION ?? '1.0.0' }

const cs = await import('../../src/daemon/controlSocket.ts')
const { MERCURY_DAEMON_PROTO, MIN_PROTO } = await import('../../src/daemon/protocol.ts')

const dir = cs.daemonDir()
const ledger = join(dir, 'fixture-spawns.log')
const note = (line: string): void => appendFileSync(ledger, `${process.pid} ${Date.now()} ${line}\n`)
note('booted')

const lock = await cs.acquireSupervisorLock()
if (lock === null) {
  note('refused-lock')
  process.exit(0)
}
note('lock-held')

const startedAt = Date.now()
const sockPath = cs.controlSockPath()
try {
  unlinkSync(sockPath)
} catch {
  note('no stale socket')
}
const server = net.createServer(sock => {
  let pending = ''
  sock.on('error', () => sock.destroy())
  sock.on('data', chunk => {
    pending += chunk.toString('utf8')
    const nl = pending.indexOf('\n')
    if (nl < 0) return
    let req: { op?: string; proto?: number; clientVersion?: string; clientBuildTree?: string | null } = {}
    try {
      req = JSON.parse(pending.slice(0, nl)) as typeof req
    } catch {
      req = {}
    }
    const reply =
      req.op === 'hello'
        ? {
            ok: true,
            op: 'hello',
            proto: MERCURY_DAEMON_PROTO,
            minProto: MIN_PROTO,
            ready: true,
            version: req.clientVersion ?? '1.0.0',
            buildTree: req.clientBuildTree ?? null,
            pid: process.pid,
            startedAt,
            ownerPid: null,
            foreground: false,
            live: 0,
            liveSessions: 0,
            warm: 0,
            restartArmed: false,
          }
        : req.op === 'ping'
          ? { ok: true, op: 'ping', version: '1.0.0', proto: MERCURY_DAEMON_PROTO }
          : req.op === 'shutdown'
            ? { ok: true, op: 'shutdown', reaped: 0, workers: [] }
            : { ok: false, code: 'EUNKNOWN', error: `unknown op ${String(req.op)}` }
    sock.end(`${JSON.stringify(reply)}\n`)
    if (req.op === 'shutdown') setImmediate(() => void leave('control:shutdown'))
  })
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(sockPath, () => resolve())
})
await cs.writeSupervisorState({
  pid: process.pid,
  version: '1.0.0',
  origin: 'transient',
  startedAt,
  dir,
  controlSock: sockPath,
  proto: MERCURY_DAEMON_PROTO,
  buildTree: null,
  ownerPid: null,
  foreground: false,
  startToken: null,
})
note('serving')

let leaving = false
async function leave(why: string): Promise<void> {
  if (leaving) return
  leaving = true
  note(`leaving ${why}`)
  cs.markSupervisorStoppingSync?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  try {
    unlinkSync(sockPath)
  } catch {
    note('socket already gone')
  }
  await cs.clearSupervisorState()
  await lock!.release()
  note('left')
  process.exit(0)
}
process.on('SIGTERM', () => void leave('SIGTERM'))
process.on('SIGINT', () => void leave('SIGINT'))
setInterval(() => {}, 1 << 30)
