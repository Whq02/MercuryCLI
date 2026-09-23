#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const ping = (path: string): Promise<string> =>
  new Promise(resolve => {
    let reply = ''
    const client = net.createConnection(path)
    const timer = setTimeout(() => client.destroy(), 5_000)
    client.on('connect', () => client.write(`${JSON.stringify({ op: 'ping' })}\n`))
    client.on('data', chunk => {
      reply += chunk.toString()
    })
    client.on('error', () => {})
    client.on('close', () => {
      clearTimeout(timer)
      resolve(reply)
    })
  })

console.log('============================================================')
console.log(' the control server start and a pipe name another process holds')
console.log('============================================================')

const HOME = mkdtempSync(join(tmpdir(), 'pipe-phantom-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_DAEMON_DIR
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { controlSockPath } = await import('../../src/daemon/controlSocket.ts')
const { startControlServer } = await import('../../src/daemon/controlServer.ts')

if (process.platform === 'win32') {
  const pipe = controlSockPath()
  let connections = 0
  const holder = net.createServer(sock => {
    connections++
    sock.on('error', () => {})
    sock.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject)
    holder.listen(pipe, () => resolve())
  })

  let outcome = 'listening'
  try {
    const handle = await startControlServer({} as never)
    await handle.close()
  } catch (error) {
    outcome = (error as NodeJS.ErrnoException).code ?? String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 200))

  check('the start does not take over the name another process holds', outcome !== 'listening', outcome)
  check('the start makes no connection to the process that holds the name', connections === 0, `${connections} connection(s)`)

  await new Promise<void>(resolve => holder.close(() => resolve()))
} else {
  const sock = controlSockPath()
  const bare = join(HOME, 'bare.sock')
  mkdirSync(dirname(sock), { recursive: true })
  const dead = join(HOME, 'dead-daemon.ts')
  writeFileSync(dead, "import net from 'node:net'\nnet.createServer().listen(process.argv[2], () => process.kill(process.pid, 'SIGKILL'))\n")
  for (const path of [sock, bare]) spawnSync(process.execPath, [dead, path], { timeout: 30_000 })
  const stale = (path: string): boolean => {
    try {
      return lstatSync(path).isSocket()
    } catch {
      return false
    }
  }
  check('a listener killed without cleanup left its socket file on the control path', stale(sock), sock)

  const bareStale = stale(bare)
  const bareOutcome = await new Promise<string>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(bare, () => server.close(() => resolve('listening')))
  }).catch((error: NodeJS.ErrnoException) => error.code ?? String(error))
  check('a bare listen over a stale socket file is refused, so the path frees only by an unlink first', bareStale && bareOutcome !== 'listening', bareOutcome)

  let outcome = 'listening'
  let reply = ''
  try {
    const handle = await startControlServer({} as never)
    reply = await ping(sock)
    await handle.close()
  } catch (error) {
    outcome = (error as NodeJS.ErrnoException).code ?? String(error)
  }
  check('the start unlinks the stale socket file and listens on its path', outcome === 'listening', outcome)
  check('the control path answers the new server', reply.includes('"op":"ping"'), reply.trim() || 'no reply')

  try {
    rmSync(sock, { force: true })
  } catch {
  }
}

try {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL PIPE PHANTOM-CONNECT CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
