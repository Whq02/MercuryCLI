#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'lsp-tool-mounted-'))
process.env.MERCURY_CONFIG_DIR = path.join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? path.join(import.meta.dir, '../../src')
const FAKE = path.join(import.meta.dir, 'fixtures', 'fake-lsp-server.mjs')
const PROJECT = path.join(SCRATCH, 'proj')
mkdirSync(PROJECT, { recursive: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return cond()
}

process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  fakecrash: {
    command: process.execPath,
    args: [FAKE],
    extensionToLanguage: { '.fk': 'fake' },
    transport: 'stdio',
    env: { FAKE_LSP_MODE: 'crash-after-init' },
    workspaceFolder: PROJECT,
    startupTimeout: 8000,
    shutdownTimeout: 1000,
    restartOnCrash: false,
  },
})

const { enableConfigs } = await import(path.join(SRC, 'utils/config.ts'))
enableConfigs()
const mgr = await import(path.join(SRC, 'services/lsp/manager.ts'))
const mounted = mgr.isLspToolMounted as (() => boolean) | undefined

section('§1 the mount predicate')
{
  check('the predicate is exported', typeof mounted === 'function')
  check('with no manager the tool is not mounted', mounted?.() === false)
  mgr.initializeLspServerManager()
  await mgr.waitForInitialization()
  const manager = mgr.getLspServerManager() as
    | { openFile(p: string, c: string): Promise<void>; getAllServers(): Map<string, { state: string }>; shutdown(): Promise<void> }
    | undefined
  const key = manager !== undefined ? [...manager.getAllServers().keys()].find(k => k === 'fakecrash' || k.endsWith(':fakecrash')) : undefined
  check('the manager initialised with the configured server', manager !== undefined && key !== undefined, manager !== undefined ? [...manager.getAllServers().keys()].join(',') : 'no manager')
  check('a configured server mounts the tool', mounted?.() === true)
  const server = key !== undefined ? manager?.getAllServers().get(key) : undefined
  const target = path.join(PROJECT, 'x.fk')
  writeFileSync(target, 'fake\n')
  await manager?.openFile(target, 'fake\n').catch(() => {})
  check('the server crashed into error (restartOnCrash false)', await until(() => server?.state === 'error', 4_000), server?.state)
  check('the tool stays mounted with its server in error — serverStatus remains callable', mounted?.() === true)
  const { LSPTool } = await import(path.join(SRC, 'tools/LSPTool/LSPTool.ts'))
  check('LSPTool.isEnabled agrees', (LSPTool as { isEnabled(): boolean }).isEnabled() === true)
  await manager?.shutdown().catch(() => {})
}

section('§2 the readers (source pins)')
{
  const tool = readFileSync(path.join(SRC, 'tools/LSPTool/LSPTool.ts'), 'utf8')
  check('the roster gate is the mount predicate', /isEnabled\(\): boolean \{\s*return isLspToolMounted\(\)/.test(tool))
  const map = readFileSync(path.join(SRC, 'utils/cockpit/harnessMap.ts'), 'utf8')
  check('the harness map keys on the same mount predicate', /lspConnectedSafe[\s\S]{0,600}isLspToolMounted\(\)/.test(map))
  const manager = readFileSync(path.join(SRC, 'services/lsp/manager.ts'), 'utf8')
  check('isLspConnected keeps its health meaning (any server not in error)', /export function isLspConnected[\s\S]{0,400}server\.state !== 'error'/.test(manager))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-lsp-tool-mounted: ALL PASS' : `\nprove-lsp-tool-mounted: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
