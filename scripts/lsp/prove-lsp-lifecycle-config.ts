
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')

const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-lsp-lifecycle-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const { createLSPServerInstance } = await import(
  '../../src/integrations/lsp/LSPServerInstance.js'
)
const { LspServerConfigSchema } = await import(
  '../../src/integrations/lsp/lspServerConfigSchema.js'
)

const FAKE = path.join(repo, 'scripts/lsp/fixtures/fake-lsp-server.mjs')

function instance(
  name: string,
  mode: string,
  extra: Record<string, unknown> = {},
) {
  return createLSPServerInstance(name, {
    command: process.execPath,
    args: [FAKE],
    extensionToLanguage: { '.fake': 'fake' },
    transport: 'stdio' as const,
    env: { FAKE_LSP_MODE: mode },
    workspaceFolder: repo,
    startupTimeout: 8000,
    scope: 'dynamic' as const,
    source: 'lifecycle-proof',
    ...extra,
  } as Parameters<typeof createLSPServerInstance>[1])
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(pred: () => boolean, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

console.log('prove-lsp-lifecycle-config — restartOnCrash + shutdownTimeout are real')

{
  const parsed = LspServerConfigSchema().safeParse({
    command: '/usr/bin/true',
    extensionToLanguage: { '.x': 'x' },
    restartOnCrash: false,
    shutdownTimeout: 1234,
  })
  check('schema accepts restartOnCrash + shutdownTimeout', parsed.success, 'LspServerConfigSchema in src/integrations/lsp/lspServerConfigSchema.ts must keep restartOnCrash (boolean) and shutdownTimeout (positive integer) as optional fields')
  for (const command of ['C:\\Program Files\\LLVM\\bin\\clangd.exe', '\\\\server\\Program Files\\clangd.exe']) {
    check('schema accepts absolute Windows executable paths containing spaces', LspServerConfigSchema().safeParse({ command, extensionToLanguage: { '.x': 'x' } }).success, `${command} (the command rule in LspServerConfigSchema, src/integrations/lsp/lspServerConfigSchema.ts, must accept an absolute Windows path with spaces)`)
  }
  check('schema still refuses a command with appended arguments', !LspServerConfigSchema().safeParse({ command: 'clangd --stdio', extensionToLanguage: { '.x': 'x' } }).success, 'the command rule in LspServerConfigSchema (src/integrations/lsp/lspServerConfigSchema.ts) must keep refusing a command that carries appended arguments')
}

{
  let threw: string | null = null
  try {
    instance('construct-probe', 'normal', { restartOnCrash: false, shutdownTimeout: 500 })
  } catch (e) {
    threw = (e as Error).message
  }
  check('construction accepts both fields (no not-yet-implemented throw)', threw === null, `${threw ?? ''} (createLSPServerInstance in src/integrations/lsp/LSPServerInstance.ts must accept restartOnCrash and shutdownTimeout in the config)`)
}

{
  const inst = instance('crash-default', 'crash-after-init')
  await inst.start()
  check('crash-default: first start reaches running', inst.state === 'running', `state=${inst.state} (start in src/integrations/lsp/LSPServerInstance.ts must reach running against scripts/lsp/fixtures/fake-lsp-server.mjs)`)
  const crashed = await waitFor(() => inst.state === 'error', 4000)
  check('crash-default: the scripted crash lands (state=error)', crashed, `state=${inst.state} (the instance in src/integrations/lsp/LSPServerInstance.ts must move to error when the server process exits)`)
  let recovered = false
  try {
    await inst.start()
    recovered = true
  } catch {
    recovered = false
  }
  check('crash-default: start() after a crash RECOVERS (lazy restart)', recovered, `state=${inst.state} (start in src/integrations/lsp/LSPServerInstance.ts must respawn after a crash when restartOnCrash is unset)`)
  await inst.stop().catch(() => {})
}

{
  const inst = instance('crash-pinned', 'crash-after-init', { restartOnCrash: false })
  await inst.start()
  const crashed = await waitFor(() => inst.state === 'error', 4000)
  check('restartOnCrash:false — the scripted crash lands', crashed, `state=${inst.state} (the instance in src/integrations/lsp/LSPServerInstance.ts must move to error when the server process exits)`)
  let refusal: string | null = null
  try {
    await inst.start()
  } catch (e) {
    refusal = (e as Error).message
  }
  check(
    'restartOnCrash:false — start() refuses with the named error',
    refusal !== null && /restartOnCrash is false/.test(refusal),
    `${refusal ?? 'no throw'} (start in src/integrations/lsp/LSPServerInstance.ts must throw a message containing restartOnCrash is false when the config sets it false)`,
  )
}

{
  const inst = instance('crash-true', 'crash-after-init', { restartOnCrash: true })
  await inst.start()
  const crashed = await waitFor(() => inst.state === 'error', 4000)
  check('restartOnCrash:true — the scripted crash lands', crashed, `state=${inst.state} (the instance in src/integrations/lsp/LSPServerInstance.ts must move to error when the server process exits)`)
  let recovered = false
  let refusal = ''
  try {
    await inst.start()
    recovered = true
  } catch (e) {
    recovered = false
    refusal = (e as Error).message
  }
  check('restartOnCrash:true — start() after a crash recovers', recovered, `${refusal || `state=${inst.state}`} (start in src/integrations/lsp/LSPServerInstance.ts must respawn after a crash when restartOnCrash is true)`)
  await inst.stop().catch(() => {})
}

{
  const inst = instance('wedged-stop', 'ignore-shutdown', { shutdownTimeout: 250 })
  await inst.start()
  check('ignore-shutdown: start reaches running', inst.state === 'running', `state=${inst.state} (start in src/integrations/lsp/LSPServerInstance.ts must reach running against scripts/lsp/fixtures/fake-lsp-server.mjs)`)
  const t0 = Date.now()
  await inst.stop()
  const elapsed = Date.now() - t0
  check('shutdownTimeout: stop() resolves (child force-killed)', inst.state === 'stopped', `state=${inst.state} (stop in src/integrations/lsp/LSPServerInstance.ts must force-kill the child once shutdownTimeout passes)`)
  check(
    `shutdownTimeout: the 250ms deadline governed the wait (elapsed ${elapsed}ms — must be ≥200 and <1800; the unconfigured default is 2000)`,
    elapsed >= 200 && elapsed < 1800,
    'stop in src/integrations/lsp/LSPServerInstance.ts must pass config.shutdownTimeout on as gracefulTimeoutMs, so the wait follows it and not the 2000ms default',
  )
}

rmSync(scratchHome, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-lsp-lifecycle-config: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-lsp-lifecycle-config: green')
process.exit(0)
