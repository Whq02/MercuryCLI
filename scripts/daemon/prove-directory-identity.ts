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
const sock = await import('../../src/daemon/control/controlSocket.ts')
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

  const { directoryIdentity, directoryIdentityKey } = await import('../../src/daemon/control/directoryIdentity.ts')
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
  assert.ok(lock, `src/daemon/control/controlSocket.ts acquireDaemonLock failed for clean dir ${dir}`)
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
  assert.ok(successor, `src/daemon/control/controlSocket.ts acquireDaemonLock failed to acquire successor after release in ${dir}`)
  const next = sock.controlSockPath()
  await listen(next, key)
  writeFileSync(sock.daemonStatePath(), JSON.stringify({ ...record, controlSock: next }))
  assert.equal((await sock.daemonControlRpc({ op: 'list', proto: 3 }, { timeoutMs: 1000 })).ok, true)
  assert.equal(await sock.acquireDaemonLock(), null)
  await successor.release()
  console.log('PASS live address and key retained, one successor after release')

  if (process.platform !== 'win32') {
    const promises = await import('node:fs/promises')
    const { mock } = await import('bun:test')
    const real = { ...promises }
    let stand: 'through' | 'owner unread' | 'another user' = 'through'
    mock.module('node:fs/promises', () => ({
      ...real,
      default: real,
      chmod: async (...args: Parameters<typeof promises.chmod>) => {
        if (stand !== 'through' && args[0] === sock.controlKeyPath()) throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' })
        return real.chmod(...args)
      },
      stat: async (...args: Parameters<typeof promises.stat>) => {
        if (stand === 'through' || args[0] !== sock.controlKeyPath()) return real.stat(...args)
        if (stand === 'owner unread') throw Object.assign(new Error('EIO: i/o error, stat'), { code: 'EIO' })
        const stats = await real.stat(args[0])
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: Number(stats.uid) + 1 })
      },
    }))
    const mint = (): Promise<string> => sock.mintControlKey().then(minted => (minted === readFileSync(sock.controlKeyPath(), 'utf8') ? 'minted' : 'minted, not the key on disk'), (error: unknown) => `REFUSED: ${error instanceof Error ? error.message : String(error)}`)
    assert.equal(await mint(), 'minted', 'the rig holds: with the stand-in passing through, a key is minted')
    stand = 'owner unread'
    const unread = await mint()
    stand = 'another user'
    const foreign = await mint()
    stand = 'through'
    assert.equal(unread, 'minted', 'a control key whose owner cannot be read after a chmod that failed is used as it was written')
    assert.match(foreign, /^REFUSED: .*belongs to another user/, 'control: a control key found to belong to another user still refuses')
    console.log('PASS a control key whose owner cannot be read is used; one found to be another user\'s still refuses')
  }
} finally {
  for (const server of sockets) if (server.listening) await close(server)
  rmSync(root, { recursive: true, force: true })
}
