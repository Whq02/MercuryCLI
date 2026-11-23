#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-record-kept-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['MERCURY_HOME', 'MERCURY_VERSIONS_DIR', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} — change the plane heal beat armPlaneHeal in src/daemon/run/heal.ts: it must leave the record, key and socket as they stand while a live owner names the plane or the record is there but unreadable, say so once in daemon.log, and write its own record only when it is missing or names a dead daemon` : ''}`)
}
const skip = (label: string, why: string): void => console.log(`  [SKIP] ${label} — ${why}`)
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const controlSocket = await import('../../src/daemon/control/controlSocket.ts')
const handover = await import('../../src/daemon/control/handover.ts')
const heal = await import('../../src/daemon/run/heal.ts')
const { makeDaemonRunState } = await import('../../src/daemon/run/state.ts')
const { DaemonBreaker } = await import('../../src/daemon/control/daemonBreaker.ts')

const OURS = 'aaaaaaaaaaaa'
const OWNER_KEY = 'the-key-of-the-live-owner'
const realImmediate = globalThis.setImmediate
const settle = async (): Promise<void> => {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 60; i++) await Promise.resolve()
    await new Promise<void>(done => realImmediate(() => done()))
  }
}
const said: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))

const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
const gone = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }).pid
if (owner.pid === undefined) throw new Error('the stand-in for the live owner did not start')
const ownerRecord = (pid: number | string): string => JSON.stringify({ pid, version: '1.0.0', origin: 'transient', startedAt: 1, dir: home, controlSock: '/fixture/control.sock', proto: 3, buildTree: OURS, ownerPid: null }, null, 2)

type World = { record: string; key: string; sock: string; rebinds: number; writes: number; beat: () => Promise<void>; servedByOther: () => number | null }
let scene = 0
const world = (recordBytes: string | null): World => {
  const dir = join(home, `scene-${++scene}`, 'daemon')
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = dir
  const record = controlSocket.daemonStatePath()
  const key = controlSocket.controlKeyPath()
  const sock = controlSocket.controlSockPath()
  writeFileSync(key, OWNER_KEY, { mode: 0o600 })
  writeFileSync(sock, '')
  writeFileSync(handover.predecessorSockPath(process.pid), '')
  if (recordBytes !== null) writeFileSync(record, recordBytes, { mode: 0o600 })
  said.length = 0
  const state = makeDaemonRunState({ dir: home, bootBuildTree: OURS, foreground: false, breaker: new DaemonBreaker(), maxInflight: 1, controlEnabled: true })
  state.currentOwnerPid = null
  const made: World = { record, key, sock, rebinds: 0, writes: 0, beat: async () => {}, servedByOther: () => state.planeServedByOther?.pid ?? null }
  state.controlServer = { close: async () => {}, rebind: async () => void made.rebinds++, leaseCount: () => 0 }
  let floor: (() => void) | null = null
  let stopTheWatches: (() => void) | null = null
  heal.armPlaneHeal(state, {
    controlKey: 'the-key-of-this-daemon',
    persistDaemonRecord: async ownerPid => {
      made.writes++
      await controlSocket.writeDaemonState({ pid: process.pid, version: '1.0.0', origin: 'transient', startedAt: 2, dir: home, controlSock: sock, buildTree: OURS, ownerPid })
    },
    askLiveSessionsForFacts: () => 0,
    armPeriodic: ((_name: string, work: () => void, also?: () => void) => {
      floor = work
      stopTheWatches = also ?? null
      return {} as never
    }) as never,
  })
  ;(stopTheWatches as (() => void) | null)?.()
  made.beat = async () => {
    floor?.()
    await settle()
  }
  return made
}
const pidOn = (record: string): unknown => {
  try {
    return (JSON.parse(readFileSync(record, 'utf8')) as { pid?: unknown }).pid
  } catch {
    return '(the record does not read)'
  }
}
const spoken = (record: string, why: string): string => `[daemon] the daemon record ${record} is there and could not be read (${why}), so a live owner of the plane cannot be ruled out: the key, the record and the socket are left as they stand — the next beat reads it again; if it stays so, move it away`
const untouched = (w: World, bytes: string): boolean => readFileSync(w.record, 'utf8') === bytes && readFileSync(w.key, 'utf8') === OWNER_KEY && w.writes === 0 && w.rebinds === 0

try {
  console.log('the daemon record — control: a record that reads and names a live owner is left alone')
  {
    const bytes = ownerRecord(owner.pid)
    const w = world(bytes)
    await w.beat()
    check('nothing of the plane is written and the owner is read as serving', untouched(w, bytes) && w.servedByOther() === owner.pid && said.length === 0, { pid: pidOn(w.record), served: w.servedByOther(), said })
  }

  console.log('the daemon record — there and unreadable while its owner lives: this daemon does not put its own in its place')
  if (!POSIX_MODES) skip('the unreadable record', 'a mode-0200 file needs a POSIX process that is not root')
  else {
    const bytes = ownerRecord(owner.pid)
    const w = world(bytes)
    chmodSync(w.record, 0o200)
    unlinkSync(w.sock)
    await w.beat()
    await w.beat()
    chmodSync(w.record, 0o600)
    check('the record still names the live owner, byte for byte', readFileSync(w.record, 'utf8') === bytes, `the record now names pid ${String(pidOn(w.record))} (this daemon is ${process.pid}, the live owner ${owner.pid})`)
    check('the owner\'s control key stands', readFileSync(w.key, 'utf8') === OWNER_KEY, 'the key was replaced by this daemon\'s: the owner\'s clients are refused')
    check('with the plane socket gone as well, the socket is not bound again over the live owner\'s plane', w.rebinds === 0 && !existsSync(w.sock), `${w.rebinds} rebind(s)`)
    check('daemon.log is told once, in two beats, what is left alone, why, and what to do', said.filter(line => line === spoken(w.record, 'EACCES')).length === 1 && said.length === 1, said)
    await w.beat()
    check('once the record reads again the beat says nothing and writes nothing', untouched(w, bytes) && said.length === 1, said)
    chmodSync(w.record, 0o200)
    await w.beat()
    chmodSync(w.record, 0o600)
    check('and a record that stops reading again is said again', said.filter(line => line === spoken(w.record, 'EACCES')).length === 2, said)
  }

  for (const [title, bytes, why] of [
    ['cut short', ownerRecord(owner.pid).slice(0, 40), 'it is not valid JSON'],
    ['with its pid written as a string', ownerRecord(String(owner.pid)), 'it names no daemon pid'],
    ['holding a list', '[]', 'it names no daemon pid'],
  ] as const) {
    console.log(`the daemon record — there, readable and ${title}: left as it stands`)
    const w = world(bytes)
    await w.beat()
    await w.beat()
    check('the record, the key and the socket are untouched', untouched(w, bytes), { pid: pidOn(w.record), key: readFileSync(w.key, 'utf8') === OWNER_KEY ? 'kept' : 'replaced', writes: w.writes, rebinds: w.rebinds })
    check('daemon.log is told once, with the reason', said.filter(line => line === spoken(w.record, why)).length === 1 && said.length === 1, said)
  }

  console.log('the daemon record — controls, as before: a record that is not there, or that names a daemon that is gone, is written again')
  {
    const missing = world(null)
    await missing.beat()
    check('no record: the key and the record are written, and the record names this daemon', missing.writes === 1 && pidOn(missing.record) === process.pid && readFileSync(missing.key, 'utf8') === 'the-key-of-this-daemon' && said.length === 0, { writes: missing.writes, pid: pidOn(missing.record), said })
    const dead = world(ownerRecord(gone ?? 1))
    await dead.beat()
    check('a record naming a daemon that is gone: written again, naming this daemon', dead.writes === 1 && pidOn(dead.record) === process.pid && said.length === 0, { writes: dead.writes, pid: pidOn(dead.record), said })
    const mode = statSync(dead.record).mode & 0o777
    check('the record written is a whole file', mode !== 0 && typeof pidOn(dead.record) === 'number')
  }
} finally {
  console.error = realError
  owner.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-daemon-record-not-rewritten: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
