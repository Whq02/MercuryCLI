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

const { enableConfigs } = await import(path.join(SRC, 'platform/settings/config.ts'))
enableConfigs()
const { createLSPServerManager } = await import(path.join(SRC, 'integrations/lsp/LSPServerManager.ts'))

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
  check('the fake server is registered', server !== undefined, 'MERCURY_LSP_SERVERS did not yield a server named fakeslow from createLSPServerManager().initialize() in src/integrations/lsp/LSPServerManager.ts')
  const first = manager.openFile(file('a.fake'), 'x')
  await new Promise(resolve => setTimeout(resolve, 150))
  check('precondition: the server is still starting when the second caller arrives', server?.state === 'starting', String(server?.state) + ' — the fake server must still be starting 150 ms into a 1200 ms init delay; check the FAKE_LSP_INIT_DELAY_MS env in this file and scripts/lsp/fixtures/fake-lsp-server.mjs')
  const second = manager.openFile(file('b.fake'), 'y')
  const [one, two] = await Promise.all([outcome(first), outcome(second)])
  check('the first open succeeds', one.ok, one.error + ' — openFile in src/integrations/lsp/LSPServerManager.ts must start the server and open the file')
  check('the second open succeeds — it joined the start instead of racing past it', two.ok, two.error + ' — openFile in src/integrations/lsp/LSPServerManager.ts must wait for the start already in flight, not fail while the server is starting')
  check('exactly one server process was spawned', spawns() === 1, `spawns=${spawns()} — a second caller must join the pending start in ensureServerStarted (src/integrations/lsp/LSPServerManager.ts), not spawn another process`)
  check('the server is running', server?.state === 'running', String(server?.state) + ' — the joined start in src/integrations/lsp/LSPServerManager.ts must leave the server running')
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
  check('the open succeeds', openOutcome.ok, openOutcome.error + ' — openFile in src/integrations/lsp/LSPServerManager.ts must succeed while a request joins its start')
  check('ensureServerStarted joined the start and answered a running server', ensureOutcome.ok, ensureOutcome.error + ' — ensureServerStarted in src/integrations/lsp/LSPServerManager.ts must wait for the start in flight and return the running server')
  check('still one spawn for this manager', spawns() - before === 1, `spawns=${spawns() - before} — ensureServerStarted in src/integrations/lsp/LSPServerManager.ts must not spawn a second process while one is starting`)
  await manager.shutdown()
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-lsp-cold-start-join: ALL PASS' : `\nprove-lsp-cold-start-join: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
