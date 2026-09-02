#!/usr/bin/env bun
// ============================================================================
//  prove-lsp-shutdown-starting — the manager's shutdown tears down a server
//  whose handshake is still in flight, and waits a stopping one out
//  (release-hardening audit rank 54).
//
//  The leak: shutdown() filtered its targets to `running` and `error`, so a
//  server in `starting` — the window between spawn and a completed
//  initialize, up to the 30s startupTimeout a cold program load fills — was
//  skipped and dropped from the registry: never sent shutdown/exit, never
//  killed, its stdin held open by a Mercury that stayed alive, running for
//  the rest of the session with no owner while an extensions reload spawned
//  a second copy. The instance's own stop() handled a starting server; the
//  filter was the sole reason it was skipped. A server already `stopping`
//  answered stop() at once, so the registry cleared before its child was
//  gone.
//
//    §1 a shutdown during the handshake ends the child and settles the
//       in-flight open, never a hang
//    §2 a shutdown during a stop in flight waits it out — the registry
//       clears after the child is gone
//    §3 control: a running server is stopped as before
//
//  The production manager over the scripted fake server (slow-init mode),
//  hermetic home. PROVE_SRC names another checkout's src (the A/B control:
//  §1 reads red at the pre-fix tree — the starting child survives).
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'lsp-shutdown-starting-'))
process.env.MERCURY_CONFIG_DIR = path.join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? path.join(import.meta.dir, '../../src')
const FAKE = path.join(import.meta.dir, 'fixtures', 'fake-lsp-server.mjs')
const PROJECT = path.join(SCRATCH, 'proj')
mkdirSync(PROJECT, { recursive: true })
const PID_FILE = path.join(SCRATCH, 'pids')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pids = (): number[] => (existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8').split('\n').filter(Boolean).map(Number) : [])
const newestPid = (): number | undefined => pids()[pids().length - 1]
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

// The one configured server: the fake in slow-init mode, claiming .fake.
process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  fakeslow: {
    command: process.execPath,
    args: [FAKE],
    extensionToLanguage: { '.fake': 'fake' },
    transport: 'stdio',
    env: { FAKE_LSP_MODE: 'slow-init', FAKE_LSP_INIT_DELAY_MS: '1500', FAKE_LSP_PID_FILE: PID_FILE },
    workspaceFolder: PROJECT,
    startupTimeout: 8000,
    shutdownTimeout: 1500,
  },
})

const { enableConfigs } = await import(path.join(SRC, 'utils/config.ts'))
enableConfigs()
const { createLSPServerManager } = await import(path.join(SRC, 'services/lsp/LSPServerManager.ts'))

type Manager = {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  openFile(p: string, content: string): Promise<void>
  getAllServers(): Map<string, { state: string; stop(): Promise<void> }>
}
async function fresh(): Promise<Manager> {
  const manager = createLSPServerManager() as Manager
  await manager.initialize()
  return manager
}
/** The env table registers its rows under a source prefix (env:<name>). */
const keyOf = (manager: Manager, name: string): string =>
  [...manager.getAllServers().keys()].find(k => k === name || k.endsWith(`:${name}`)) ?? name
const file = (name: string): string => {
  const p = path.join(PROJECT, name)
  writeFileSync(p, 'fake content\n')
  return p
}
const settle = async (p: Promise<unknown>, ms: number): Promise<'settled' | 'hung'> =>
  Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), sleep(ms).then(() => 'hung' as const)])

section('§1 a shutdown during the handshake ends the child')
{
  const manager = await fresh()
  const server = manager.getAllServers().get(keyOf(manager, 'fakeslow'))
  check('the fake server is registered', server !== undefined, [...manager.getAllServers().keys()].join(','))
  const opening = manager.openFile(file('a.fake'), 'x')
  opening.catch(() => {})
  check('the open leaves the server starting', await until(() => server?.state === 'starting', 3_000), server?.state)
  check('the child was spawned (its pid is on record)', await until(() => newestPid() !== undefined, 3_000))
  const pid = newestPid() as number
  check('precondition: the child is alive mid-handshake', alive(pid))
  const t0 = Date.now()
  await manager.shutdown()
  check('shutdown settles promptly', Date.now() - t0 < 6_000, `${Date.now() - t0}ms`)
  check('the starting child is gone after shutdown', await until(() => !alive(pid), 5_000), `pid ${pid} still alive`)
  check('the in-flight open settles (rejects or resolves) — never a hang', (await settle(opening, 6_000)) === 'settled')
  check('the registry is clear', manager.getAllServers().size === 0)
}

section('§2 a shutdown during a stop in flight waits it out')
{
  const manager = await fresh()
  const server = manager.getAllServers().get(keyOf(manager, 'fakeslow')) as { state: string; stop(): Promise<void> }
  await manager.openFile(file('b.fake'), 'y')
  check('the server is running', server.state === 'running', server.state)
  const pid = newestPid() as number
  const stopping = server.stop()
  check('the server is stopping', server.state === 'stopping', server.state)
  await manager.shutdown()
  check('shutdown returned only once the child was gone', !alive(pid), `pid ${pid} still alive`)
  check('the stop in flight settled', (await settle(stopping, 3_000)) === 'settled')
  check('the server reads stopped', server.state === 'stopped', server.state)
}

section('§3 control: a running server is stopped as before')
{
  const manager = await fresh()
  await manager.openFile(file('c.fake'), 'z')
  const pid = newestPid() as number
  check('precondition: alive while running', alive(pid))
  await manager.shutdown()
  check('the running child is gone after shutdown', await until(() => !alive(pid), 5_000))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-lsp-shutdown-starting: ALL PASS' : `\nprove-lsp-shutdown-starting: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
