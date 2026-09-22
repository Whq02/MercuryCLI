#!/usr/bin/env bun
import net, { type Socket } from 'node:net'
import { appendFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'

const arg = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const LISTEN = arg('--listen')
const UPSTREAM = arg('--upstream')
const LEDGER = arg('--ledger')
const SCENE = arg('--scene') ?? 'relay'
const DEAF_MS = Number(arg('--deaf-ms') ?? 4000)
if (LISTEN === undefined || UPSTREAM === undefined || LEDGER === undefined) {
  console.error('usage: lost-reply-standin.ts --listen <sock> --upstream <sock> --ledger <file> [--scene relay|lose-after-write|lose-before-write|hold-reply] [--deaf-ms n]')
  process.exit(2)
}
const KNOWN = new Set(['relay', 'lose-after-write', 'lose-before-write', 'hold-reply'])
if (!KNOWN.has(SCENE)) {
  console.error(`unknown scene ${SCENE}`)
  process.exit(2)
}

const t0 = Date.now()
const note = (row: Record<string, unknown>): void => {
  appendFileSync(LEDGER, `${JSON.stringify({ at: Date.now(), sinceMs: Date.now() - t0, ...row })}\n`)
}

let n = 0
let admitsSeen = 0
const held: Socket[] = []

function opOf(line: string): string {
  try {
    const parsed = JSON.parse(line) as { op?: unknown }
    return typeof parsed.op === 'string' ? parsed.op : '?'
  } catch {
    return '?'
  }
}
function sessionIdOf(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { sessionId?: unknown; ok?: unknown }
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
  } catch {
    return undefined
  }
}
function okOf(line: string): boolean | undefined {
  try {
    const parsed = JSON.parse(line) as { ok?: unknown }
    return typeof parsed.ok === 'boolean' ? parsed.ok : undefined
  } catch {
    return undefined
  }
}

function forward(frame: string, onReply: (line: string | null) => void): void {
  const up = net.connect(UPSTREAM!)
  let pending = ''
  let answered = false
  const settle = (line: string | null): void => {
    if (answered) return
    answered = true
    onReply(line)
    up.destroy()
  }
  up.on('connect', () => up.write(frame))
  up.on('data', chunk => {
    pending += chunk.toString('utf8')
    const nl = pending.indexOf('\n')
    if (nl < 0) return
    settle(pending.slice(0, nl + 1))
  })
  up.on('error', () => settle(null))
  up.on('close', () => settle(null))
}

function serve(sock: Socket): void {
  const id = ++n
  let pending = ''
  let read = false
  sock.on('error', () => sock.destroy())
  sock.on('data', chunk => {
    if (read) return
    pending += chunk.toString('utf8')
    const nl = pending.indexOf('\n')
    if (nl < 0) return
    read = true
    const frame = pending.slice(0, nl + 1)
    const op = opOf(frame)
    const isAdmit = op === 'sessionAdmit'
    if (isAdmit) admitsSeen++
    const firstAdmit = isAdmit && admitsSeen === 1
    const action = firstAdmit && SCENE === 'lose-after-write' ? 'swallow' : firstAdmit && SCENE === 'hold-reply' ? 'hold' : 'relay'
    const sentAt = Date.now()
    note({ n: id, op, action: `${action}:frame-forwarded` })
    forward(frame, reply => {
      const ms = Date.now() - sentAt
      if (reply === null) {
        note({ n: id, op, action: 'upstream-closed-without-reply', ms })
        sock.destroy()
        return
      }
      const facts = { ok: okOf(reply), sessionId: sessionIdOf(reply), ms }
      if (action === 'swallow') {
        note({ n: id, op, action: 'reply-swallowed-client-closed', ...facts })
        sock.destroy()
        return
      }
      if (action === 'hold') {
        note({ n: id, op, action: 'reply-held-client-left-open', ...facts })
        held.push(sock)
        sock.on('close', () => note({ n: id, op, action: 'held-client-closed-by-client', ms: Date.now() - sentAt }))
        return
      }
      note({ n: id, op, action: 'reply-relayed', ...facts })
      sock.end(reply)
      if (SCENE === 'lose-before-write' && op === 'hello' && facts.ok === true && !deafOnce) {
        deafOnce = true
        goDeaf()
      }
    })
  })
}

let deafOnce = false
function goDeaf(): void {
  server.close(() => {
    note({ action: 'deaf', deafMs: DEAF_MS })
    setTimeout(() => {
      try {
        unlinkSync(LISTEN!)
      } catch {
        note({ action: 'no-lingering-socket-file' })
      }
      listen(LISTEN!)
        .then(s => {
          server = s
          note({ action: 'listening-again' })
        })
        .catch(err => note({ action: 'relisten-failed', error: String(err) }))
    }, DEAF_MS)
  })
}

function listen(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(serve)
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

if (!existsSync(UPSTREAM)) {
  if (!existsSync(LISTEN)) {
    console.error(`no socket at ${LISTEN} to take over`)
    process.exit(3)
  }
  renameSync(LISTEN, UPSTREAM)
}
let server = await listen(LISTEN)
note({ action: 'listening', scene: SCENE, listen: LISTEN, upstream: UPSTREAM })
console.log(`LISTENING ${LISTEN}`)

const leave = (): void => {
  note({ action: 'leaving' })
  for (const s of held) s.destroy()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
setInterval(() => {}, 1 << 30)
