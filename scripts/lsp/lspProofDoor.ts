import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

export const REPO = path.resolve(import.meta.dir, '../..')
export const FAKE_SERVER = path.join(REPO, 'scripts/lsp/fixtures/fake-lsp-server.mjs')
export const FAILING_SERVER = path.join(REPO, 'scripts/lsp/fixtures/failing-lsp-server.mjs')
export const TS_SIDECAR_ENTRY = path.join(REPO, 'src/services/lsp/tsSidecar/entry.ts')

let failures = 0
export function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
export function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
export function finish(name: string): never {
  console.log(failures === 0 ? `\n${name}: ALL PASS` : `\n${name}: ${failures} FAIL`)
  process.exit(failures === 0 ? 0 : 1)
}

export function armScratch(label: string): string {
  const scratch = mkdtempSync(path.join(tmpdir(), `${label}-`))
  process.env.MERCURY_CONFIG_DIR = path.join(scratch, 'home')
  mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP_SERVERS
  delete process.env.MERCURY_HOME
  process.env.MERCURY_LSP_CPP = '0'
  process.env.MERCURY_LSP_PYTHON = '0'
  process.env.MERCURY_LSP_RUFF = '0'
  process.env.MERCURY_LSP_WEB = '0'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  return scratch
}

export function writeProject(scratch: string, name: string, files: Record<string, string>): string {
  const root = path.join(scratch, name)
  mkdirSync(root, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}

export const TS_PROBE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'diagnostic-probe', private: true, scripts: { typecheck: 'tsc --noEmit' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }),
  'lib.ts': 'export const budget: number = 1\n',
  'main.ts': 'import { budget } from "./lib"\nexport const label: string = budget\n',
}

export function fixtureServer(name: string, script: string, env: Record<string, string>, extension: string, language: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [name]: {
      command: process.execPath,
      args: [script],
      extensionToLanguage: { [extension]: language },
      transport: 'stdio',
      env,
      startupTimeout: 8000,
      shutdownTimeout: 1500,
      ...extra,
    },
  }
}

export type Driven = { text: string; isError: boolean; data: Record<string, unknown> | null }

export async function openToolDoor(root: string, name = 'LspRead') {
  const harness = await import(path.join(REPO, 'scripts/ast-tools/lib/harness.ts'))
  await harness.enterRoot(root)
  const { LSP_TOOLS } = await import(path.join(REPO, 'src/tools/LSPTool/LSPTool.ts'))
  const tool = LSP_TOOLS.find((tool: { name: string }) => tool.name === name)!
  const lspManager = await import(path.join(REPO, 'src/services/lsp/manager.ts'))
  lspManager.initializeLspServerManager()
  await lspManager.waitForInitialization()
  const prover = await harness.makeContext(LSP_TOOLS, { mode: 'default' })
  let armed: AbortController | null = null
  return {
    tool,
    prover,
    tools: LSP_TOOLS,
    driveNamed: (name: string, input: Record<string, unknown>, answer: 'allow' | 'deny' = 'allow') => harness.drive(LSP_TOOLS.find((tool: { name: string }) => tool.name === name)!, input, prover, { answer }),
    manager: () => lspManager.getLspServerManager(),
    drive: async (input: Record<string, unknown>): Promise<Driven> => {
      const ctx = prover.ctx as { abortController: AbortController }
      if (armed !== null) ctx.abortController = armed
      const out = await harness.drive(tool, input, prover)
      if (armed !== null) {
        armed = null
        ctx.abortController = new AbortController()
      }
      return { text: out.text, isError: out.isError, data: out.data }
    },
    abortAfter: (ms: number): void => {
      const controller = new AbortController()
      armed = controller
      setTimeout(() => controller.abort(), ms)
    },
    close: async () => {
      await lspManager.shutdownLspServerManager()
    },
  }
}

export function cleanup(scratch: string): void {
  rmSync(scratch, { recursive: true, force: true })
}
