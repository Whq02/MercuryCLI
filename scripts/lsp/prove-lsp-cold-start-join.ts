#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'lsp-cold-start-join-'))
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
const spawns = (): number => (existsSync(PID_FILE) ? readFileSync(PID_FILE, 'utf8').split('\n').filter(Boolean).length : 0)
const file = (name: string): string => {
  const p = path.join(PROJECT, name)
  writeFileSync(p, 'fake content\n')
  return p
}

process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  fakeslow: {
    command: process.execPath,
    args: [FAKE],
    extensionToLanguage: { '.fake': 'fake' },
    transport: 'stdio',
    env: { FAKE_LSP_MODE: 'slow-init', FAKE_LSP_INIT_DELAY_MS: '1200', FAKE_LSP_PID_FILE: PID_FILE },
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
  ensureServerStarted(p: string): Promise<{ state: string } | undefined>
  getAllServers(): Map<string, { state: string }>
}
const keyOf = (manager: Manager, name: string): string =>
  [...manager.getAllServers().keys()].find(k => k === name || k.endsWith(`:${name}`)) ?? name
const outcome = async (p: Promise<unknown>): Promise<{ ok: boolean; error: string }> =>
  p.then(
    () => ({ ok: true, error: '' }),
    (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  )

section('§1 two opens during the cold start both succeed, on one spawn')
{
  const manager = createLSPServerManager() as Manager
  await manager.initialize()
  const server = manager.getAllServers().get(keyOf(manager, 'fakeslow'))
  check('the fake server is registered', server !== undefined)
  const first = manager.openFile(file('a.fake'), 'x')
  await new Promise(resolve => setTimeout(resolve, 150))
  check('precondition: the server is still starting when the second caller arrives', server?.state === 'starting', server?.state)
  const second = manager.openFile(file('b.fake'), 'y')
  const [one, two] = await Promise.all([outcome(first), outcome(second)])
  check('the first open succeeds', one.ok, one.error)
  check('the second open succeeds — it joined the start instead of racing past it', two.ok, two.error)
  check('exactly one server process was spawned', spawns() === 1, `spawns=${spawns()}`)
  check('the server is running', server?.state === 'running', server?.state)
  await manager.shutdown()
}

section('§2 a request during the cold start joins it too')
{
  const manager = createLSPServerManager() as Manager
  await manager.initialize()
  const before = spawns()
  const opening = manager.openFile(file('c.fake'), 'z')
  await new Promise(resolve => setTimeout(resolve, 150))
  const ensured = outcome(manager.ensureServerStarted(file('c.fake')))
  const [openOutcome, ensureOutcome] = await Promise.all([outcome(opening), ensured])
  check('the open succeeds', openOutcome.ok, openOutcome.error)
  check('ensureServerStarted joined the start and answered a running server', ensureOutcome.ok, ensureOutcome.error)
  check('still one spawn for this manager', spawns() - before === 1, `spawns=${spawns() - before}`)
  await manager.shutdown()
}

section('§3 the format-owner resolver joins a start in flight (source pin)')
{
  const ops = readFileSync(path.join(SRC, 'tools/LSPTool/mercuryOps.ts'), 'utf8')
  const at = ops.indexOf('async function resolveFormatOwner(')
  const body = at >= 0 ? ops.slice(at, at + 1400) : ''
  check("the resolver starts every claimant that is not running (a starting one is joined)", body.includes("claimant.state !== 'running'"))
  check('and never repeats the two-state guard', !body.includes("claimant.state === 'stopped' || claimant.state === 'error'"))
  const manager = readFileSync(path.join(SRC, 'services/lsp/LSPServerManager.ts'), 'utf8')
  check('the manager routes open and ensure through one readiness owner', (manager.match(/await readyFor\(server\)/g) ?? []).length >= 2)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-lsp-cold-start-join: ALL PASS' : `\nprove-lsp-cold-start-join: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
