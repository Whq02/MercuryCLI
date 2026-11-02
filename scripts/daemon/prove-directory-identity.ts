#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-identity-')))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_DAEMON_DIR = join(root, 'MixedCaseDaemon')
delete process.env.MERCURY_HOME
const dir = process.env.MERCURY_DAEMON_DIR
mkdirSync(dir, { recursive: true })
const upper = process.platform === 'linux' ? join(root, 'MIXEDCASEDAEMON') : dir.toUpperCase()
if (process.platform === 'linux' && !existsSync(upper)) symlinkSync(dir, upper, 'dir')
const aliases = [dir, upper, ...(process.platform === 'win32' ? [dir.replaceAll('\\', '/')] : [])]
const sockets: net.Server[] = []
const sock = await import('../../src/daemon/controlSocket.ts')
const listen = async (path: string, key: string): Promise<net.Server> => {
  const server = net.createServer(connection => {
    connection.once('data', bytes => {
      const request = JSON.parse(bytes.toString())
      connection.end(JSON.stringify(request.auth === key ? { ok: true, op: 'list', jobs: [] } : { ok: false, code: 'EAUTH' }) + '\n')
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  sockets.push(server)
  return server
}
const close = (server: net.Server): Promise<void> => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
try {
  assert.equal(statSync(dir, { bigint: true }).ino, statSync(upper, { bigint: true }).ino, 'fixture spellings must identify one native directory')
  const pipes = aliases.map(alias => {
    process.env.MERCURY_DAEMON_DIR = alias
    return (sock.controlSockPath as (platform?: string) => string)('win32')
  })
  assert.equal(new Set(pipes).size, 1, 'one native directory must have one Windows pipe')
  console.log('PASS case and separator aliases share one pipe')

  const { directoryIdentity, directoryIdentityKey } = await import('../../src/utils/directoryIdentity.ts')
  assert.equal(directoryIdentity(dir).key, directoryIdentity(upper).key)
  const known = { dev: 17n, ino: 8444249301431039n }
  assert.equal(directoryIdentityKey('C:\\Work\\Project', known, 'win32'), directoryIdentityKey('c:/WORK/PROJECT', known, 'win32'))
  assert.notEqual(directoryIdentityKey('C:\\Work\\Project', known, 'win32'), directoryIdentityKey('C:\\Work\\Project', { ...known, dev: 18n }, 'win32'))
  assert.notEqual(directoryIdentityKey('C:\\Work\\Project', known, 'win32'), directoryIdentityKey('C:\\Work\\Project', { ...known, ino: known.ino + 1n }, 'win32'))
  assert.equal(directoryIdentityKey('\\\\?\\C:\\Work\\Project\\', null, 'win32'), directoryIdentityKey('c:/WORK/PROJECT', null, 'win32'))
  assert.equal(directoryIdentityKey('\\\\?\\UNC\\Server\\Share\\Project', null, 'win32'), directoryIdentityKey('\\\\server\\share\\PROJECT', null, 'win32'))
  assert.notEqual(directoryIdentityKey('/Work/Project', null, 'linux'), directoryIdentityKey('/work/project', null, 'linux'))
  console.log('PASS native volume/file IDs and Windows-shaped fallback fixtures')

  process.env.MERCURY_DAEMON_DIR = dir
  const lock = await sock.acquireDaemonLock()
  assert.ok(lock)
  process.env.MERCURY_DAEMON_DIR = upper
  assert.equal(await sock.acquireDaemonLock(), null, 'case aliases cannot own a second daemon')
  const key = await sock.mintControlKey()
  const old = process.platform === 'win32'
    ? `\\\\.\\pipe\\hermes-daemon-${createHash('sha1').update(upper).digest('hex').slice(0, 12)}`
    : join(root, 'old.sock')
  const server = await listen(old, key)
  const record = { pid: process.pid, version: '1.0.2', origin: 'transient', startedAt: Date.now(), dir: root, controlSock: old }
  const legacyPipe = '\\\\.\\pipe\\hermes-daemon-0123456789ab'
  writeFileSync(sock.daemonStatePath(), JSON.stringify({ ...record, controlSock: legacyPipe }))
  assert.equal(sock.controlConnectPath('win32'), legacyPipe, 'Windows clients discover the live recorded pipe')
  writeFileSync(sock.daemonStatePath(), JSON.stringify({ ...record, controlSock: '\\\\remote\\pipe\\hermes-daemon-0123456789ab' }))
  assert.equal(sock.controlConnectPath('win32'), pipes[0], 'a record cannot redirect credentials to a remote pipe')
  writeFileSync(sock.daemonStatePath(), JSON.stringify({ ...record, pid: -1, controlSock: legacyPipe }))
  assert.equal(sock.controlConnectPath('win32'), pipes[0], 'invalid ownership does not pin a stale address')
  writeFileSync(sock.daemonStatePath(), JSON.stringify(record))
  for (const alias of aliases) {
    process.env.MERCURY_DAEMON_DIR = alias
    sock.clearControlKeyMemo()
    const reply = await sock.daemonControlRpc({ op: 'list', proto: 3 }, { timeoutMs: 1000 })
    assert.equal(reply.ok, true, `recorded authenticated address through ${alias}`)
  }
  assert.equal(readFileSync(sock.daemonStatePath(), 'utf8'), JSON.stringify(record), 'discovery leaves the live record intact')
  assert.equal(readFileSync(sock.controlKeyPath(), 'utf8'), key, 'discovery never rotates the live key')
  await close(server)
  await sock.clearDeadDaemonRecords()
  await lock.release()
  const successor = await sock.acquireDaemonLock()
  assert.ok(successor)
  const next = sock.controlSockPath()
  await listen(next, key)
  writeFileSync(sock.daemonStatePath(), JSON.stringify({ ...record, controlSock: next }))
  assert.equal((await sock.daemonControlRpc({ op: 'list', proto: 3 }, { timeoutMs: 1000 })).ok, true)
  assert.equal(await sock.acquireDaemonLock(), null)
  await successor.release()
  console.log('PASS live address and key retained, one successor after release')
} finally {
  for (const server of sockets) if (server.listening) await close(server)
  rmSync(root, { recursive: true, force: true })
}
