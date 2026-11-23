#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dir, '../..')
const fakeServer = path.join(repo, 'scripts/lsp/fixtures/fake-lsp-server.mjs')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-catalogue-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'lsp-catalogue-home-'))
const shimBin = path.join(scratch, 'shim-bin')
mkdirSync(shimBin)
writeFileSync(path.join(scratch, 'Cargo.toml'), '[package]\nname = "proof"\n')
writeFileSync(path.join(scratch, 'x.rs'), 'fn main() {}\n')
const plantServerShim = (dir: string, name: string): string => {
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`)
    writeFileSync(file, `@echo off\r\n"${process.execPath}" "${fakeServer}" %*\r\n`)
    return file
  }
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}"\n`)
  chmodSync(file, 0o755)
  return file
}
const shim = plantServerShim(shimBin, 'rust-analyzer')
process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`
delete process.env.MERCURY_LSP
process.chdir(scratch)

process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  linty: {
    command: process.execPath,
    args: [fakeServer],
    extensionToLanguage: { '.qq': 'quux', '.rr': 'ruux' },
    diagnosticsOnly: true,
  },
  fully: {
    command: process.execPath,
    args: [fakeServer],
    extensionToLanguage: { '.qq': 'quux' },
  },
  ghost: {
    command: process.execPath,
    args: [fakeServer],
    extensionToLanguage: { '.ss': 'suux' },
    disabled: true,
  },
})

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

console.log('— T. the data table —')
const { SERVER_CATALOGUE, probeCatalogueEntry, catalogueServerConfigs, serverCatalogueRecords } =
  await import('../../src/integrations/lsp/serverCatalogue.js')
{
  const ids = new Set(SERVER_CATALOGUE.map(e => e.id))
  check('ids are unique', ids.size === SERVER_CATALOGUE.length, 'SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts has two rows with the same id')
  check('every row has binaries + a remedy', SERVER_CATALOGUE.every(e => e.binaries.length > 0 && e.remedy.length > 0), 'a row of SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts has an empty binaries list or an empty remedy')
  check(
    'every extension key is dotted and mapped to a language id',
    SERVER_CATALOGUE.every(e =>
      Object.entries(e.extensionToLanguage).every(([k, v]) => k.startsWith('.') && v.length > 0),
    ),
    'a row of SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts has an extensionToLanguage key without a leading dot or an empty language id',
  )
  check('the mainstream set is present (rust/go/zig/java/kotlin/c#/swift/ruby/php/lua/bash/yaml/terraform/dockerfile/elixir)',
    ['rust-analyzer', 'gopls', 'zls', 'jdtls', 'kotlin-language-server', 'csharp', 'sourcekit-lsp', 'ruby-lsp', 'intelephense', 'lua-language-server', 'bash-language-server', 'yaml-language-server', 'terraform-ls', 'docker-langserver', 'elixir-ls'].every(id => ids.has(id)), 'SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts lacks a row for one of the listed ids')
}

console.log('— D. detection truth —')
{
  const rust = SERVER_CATALOGUE.find(e => e.id === 'rust-analyzer')!
  const gopls = SERVER_CATALOGUE.find(e => e.id === 'gopls')!
  const probe = probeCatalogueEntry(rust)
  check('binary ∩ marker probes offered material', probe.binaryPath === shim && probe.rootMatched, `${JSON.stringify(probe)} (probeCatalogueEntry in src/integrations/lsp/serverCatalogue.ts must find the rust-analyzer shim on PATH and match the Cargo.toml root marker)`)
  const configs = catalogueServerConfigs()
  check('the offered row joins the config map', 'catalogue:rust-analyzer' in configs, `${Object.keys(configs).join(',')} (catalogueServerConfigs in src/integrations/lsp/serverCatalogue.ts must include a row whose binary and root marker are both found)`)
  check('the offered row carries the resolved binary + markers', configs['catalogue:rust-analyzer']?.command === shim && Array.isArray(configs['catalogue:rust-analyzer']?.rootMarkers), 'catalogueServerConfigs in src/integrations/lsp/serverCatalogue.ts must set command to the resolved binary path and carry rootMarkers')
  const goProbe = probeCatalogueEntry(gopls)
  const goOffered = 'catalogue:gopls' in configs
  if (goProbe.binaryPath) {
    check('gopls binary without go.mod is NOT offered', !goOffered && !goProbe.rootMatched, `${JSON.stringify(goProbe)} (catalogueServerConfigs in src/integrations/lsp/serverCatalogue.ts must not offer a row whose root marker is missing)`)
  } else {
    check('no gopls binary ⇒ not offered', !goOffered, 'catalogueServerConfigs in src/integrations/lsp/serverCatalogue.ts must not offer a row whose binary is not found')
  }
  const records = serverCatalogueRecords()
  const rustRecord = records.find(r => r.id === 'catalogue:lsp:rust-analyzer')
  check('/health row says offered with the spawn story', rustRecord?.state === 'configured' && /offered/.test(rustRecord?.label ?? '') && /spawns lazily/.test(rustRecord?.detail ?? ''), `${JSON.stringify(rustRecord)} (serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts must give an offered row state configured, an offered label and a detail saying it spawns lazily)`)
  const missing = records.find(r => r.state === 'unavailable')
  check('an absent binary reads unavailable WITH its remedy', missing !== undefined && typeof missing.remedy === 'string', `${JSON.stringify(missing?.id)} (serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts must give an unavailable row its remedy string)`)
  const localBin = path.join(scratch, 'node_modules', '.bin')
  mkdirSync(localBin, { recursive: true })
  const localShim = plantServerShim(localBin, 'rust-analyzer')
  const localProbe = probeCatalogueEntry(rust)
  check('project-local bin outranks PATH', localProbe.binaryPath === localShim && localProbe.binarySource === 'project-local', `${JSON.stringify(localProbe)} (probeCatalogueEntry in src/integrations/lsp/serverCatalogue.ts must search node_modules/.bin of the project before PATH)`)
}

console.log('— C. the offered row through the REAL pipeline —')
const mgrModule = await import('../../src/integrations/lsp/serverManagerLifecycle.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
check('manager init succeeds', mgrModule.getInitializationStatus().status === 'success', `${JSON.stringify(mgrModule.getInitializationStatus())} (initializeLspServerManager in src/integrations/lsp/serverManagerLifecycle.ts did not finish with success)`)
const manager = mgrModule.getLspServerManager()!
{
  const names = [...manager.getAllServers().keys()]
  check('catalogue row registered', names.includes('catalogue:rust-analyzer'), `${names.join(',')} (the manager in src/integrations/lsp/serverManagerLifecycle.ts must register the rows from catalogueServerConfigs)`)
  check('disabled env row dropped', !names.includes('env:ghost'), `${names.join(',')} (an MERCURY_LSP_SERVERS entry with disabled true must be dropped when the manager in src/integrations/lsp/serverManagerLifecycle.ts builds its server list)`)
  const rsFile = path.join(scratch, 'x.rs')
  const server = await manager.ensureServerStarted(rsFile)
  check('first use SPAWNS the catalogue server (initialize completed)', server?.state === 'running', `${server?.state} (ensureServerStarted in src/integrations/lsp/serverManagerLifecycle.ts must spawn the catalogue server on first use and finish initialize)`)
  const answer = await manager.sendRequest<unknown>(rsFile, 'textDocument/hover', {
    textDocument: { uri: pathToFileURL(rsFile).href },
    position: { line: 0, character: 0 },
  })
  check('a request round-trips through the spawned server', answer === null, `${JSON.stringify(answer)} (sendRequest in src/integrations/lsp/serverManagerLifecycle.ts must return the hover answer of the spawned scripts/lsp/fixtures/fake-lsp-server.mjs)`)
}

console.log('— R. routing: the linter class + precedence —')
{
  const qq = path.join(scratch, 'a.qq')
  writeFileSync(qq, 'x\n')
  const claimants = manager.getServersForFile(qq).map(s => s.name)
  check('both env claimants indexed in insertion order', claimants.join(',') === 'env:linty,env:fully', `${claimants.join(',')} (getServersForFile in src/integrations/lsp/serverManagerLifecycle.ts must list every server claiming the extension, in insertion order)`)
  check('the diagnosticsOnly claimant is NOT the primary', manager.getServerForFile(qq)?.name === 'env:fully', 'getServerForFile in src/integrations/lsp/serverManagerLifecycle.ts must skip a diagnosticsOnly server when another server claims the extension')
  const rr = path.join(scratch, 'b.rr')
  writeFileSync(rr, 'x\n')
  check('a linter ALONE still owns its extension (diagnostics deserve an owner)', manager.getServerForFile(rr)?.name === 'env:linty', 'getServerForFile in src/integrations/lsp/serverManagerLifecycle.ts must fall back to a diagnosticsOnly server when it is the only claimant')
}

console.log('— L. idle timeout + init-failure backoff —')
const { createLSPServerInstance } = await import('../../src/integrations/lsp/LSPServerInstance.js')
{
  const idle = createLSPServerInstance('idle-proof', {
    command: process.execPath,
    args: [fakeServer],
    extensionToLanguage: { '.zz': 'zed' },
    transport: 'stdio',
    idleTimeoutMs: 150,
    scope: 'dynamic',
    source: 'proof',
  } as never)
  await idle.start()
  check('idle server starts', idle.state === 'running', `state=${idle.state} (start in src/integrations/lsp/LSPServerInstance.ts must reach running)`)
  await new Promise(r => setTimeout(r, 500))
  check('idleTimeoutMs stopped the idle server', idle.state === 'stopped', `${idle.state} (LSPServerInstance in src/integrations/lsp/LSPServerInstance.ts must stop the server after idleTimeoutMs of no use)`)
  await idle.start()
  check('lazy restart after idle stop works', idle.state === 'running', `state=${idle.state} (start in src/integrations/lsp/LSPServerInstance.ts must restart a server stopped by the idle timeout)`)
  await idle.stop()

  const doomed = createLSPServerInstance('backoff-proof', {
    command: process.execPath,
    args: ['-e', 'console.error("component not installed: try rustup component add"); process.exit(1)'],
    extensionToLanguage: { '.zz': 'zed' },
    transport: 'stdio',
    startupTimeout: 10_000,
    scope: 'dynamic',
    source: 'proof',
  } as never)
  let firstError = ''
  const t0 = Date.now()
  await doomed.start().catch(e => (firstError = (e as Error).message))
  const firstMs = Date.now() - t0
  check('doomed initialize fails FAST (never the startup timeout)', firstError.length > 0 && firstMs < 3_000, `${firstMs}ms: ${firstError} (start in src/integrations/lsp/LSPServerInstance.ts must fail as soon as the child exits, not wait for startupTimeout)`)
  check("the failure carries the child's own stderr (the honest remedy)", /server said: .*component not installed/.test(firstError), `${firstError} (start in src/integrations/lsp/LSPServerInstance.ts must append the child's stderr to the failure as server said: ...)`)
  let secondError = ''
  const t1 = Date.now()
  await doomed.start().catch(e => (secondError = (e as Error).message))
  const secondMs = Date.now() - t1
  check('the second attempt refuses inside the backoff window, FAST, with the server’s own reason and no retry invitation', /did not start \(1 attempt this session\): exited with exit code 1 — server said: .*component not installed/.test(secondError) && !/backing off|retry/i.test(secondError) && secondMs < 100, `${secondMs}ms: ${secondError}`)
  let thirdError = ''
  await doomed.restart().catch(e => (thirdError = (e as Error).message))
  check('restart() clears the backoff (a real attempt runs again and the count starts over)', /\(1 attempt this session\): exited with exit code 1 — server said/.test(thirdError) && !/backing off/.test(thirdError), thirdError)
}

console.log('— O. capabilities + rawRequest —')
const { runMercuryLspOp } = await import('../../src/tools/lsp/mercuryOps.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { LspReadTool, LspRequestTool } = await import('../../src/tools/lsp/lspTools.js')
{
  const permCtx = {
    ...getEmptyToolPermissionContext(),
    additionalWorkingDirectories: new Map([[scratch, { source: 'session' }]]),
  }
  const ctx = {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permCtx }),
  } as never
  const rsFile = path.join(scratch, 'x.rs')
  const envFor = (input: Record<string, unknown>) => ({
    input: input as never,
    absolutePath: rsFile,
    cwd: scratch,
    manager,
    tool: { name: 'LSP' } as never,
    context: ctx,
  })
  const caps = await runMercuryLspOp(envFor({ operation: 'capabilities', filePath: rsFile }))
  check('capabilities dumps the claimant advertisement', /capabilities for/.test(caps.result) && caps.effect.outcome !== 'failed', caps.result.slice(0, 120))
  const refused = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'workspace/executeCommand', params: '{}' }))
  check('rawRequest refuses the edit-class method by name', refused.effect.outcome === 'failed' && /edit-class/.test(refused.result) && /LspCodeAction/.test(refused.result), refused.result.slice(0, 160))
  const renameRefused = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'textDocument/rename', params: '{}' }))
  check('rawRequest points rename at the typed op', renameRefused.effect.outcome === 'failed' && /LspRename/.test(renameRefused.result), renameRefused.result.slice(0, 160))
  const raw = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'textDocument/documentHighlight', params: JSON.stringify({ textDocument: { uri: pathToFileURL(rsFile).href }, position: { line: 0, character: 0 } }) }))
  check('a non-edit method answers raw (nothing applied)', raw.effect.outcome === 'succeeded' && /nothing was applied/.test(raw.result), raw.result.slice(0, 160))
  const badJson = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'textDocument/documentHighlight', params: '{nope' }))
  check('malformed params JSON refuses typed', badJson.effect.outcome === 'failed' && /not valid JSON/.test(badJson.result))
  check('rawRequest is write-classed unconditionally', LspRequestTool.isReadOnly({ filePath: rsFile, method: 'x' } as never) === false)
  check('the serverStatus read stays read-only', LspReadTool.isReadOnly({ operation: 'serverStatus', filePath: rsFile } as never) === true)
}

await mgrModule.shutdownLspServerManager()
console.log('')
if (failures > 0) {
  console.error(`prove-lsp-catalogue: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-catalogue: GREEN — the catalogue offers honestly, routes linters aside, and the escape hatch cannot write')
