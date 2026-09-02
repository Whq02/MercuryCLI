#!/usr/bin/env bun
// prove-lsp-catalogue — the auto-offered server catalogue (parity spec 04
// C1), the linter class, the lifecycle additions, and the two op gaps:
//   T. the data table is shape-valid (unique ids, dotted extensions,
//      non-empty binaries/remedies)
//   D. detection truth: no binary ⇒ unavailable; binary without a root
//      marker ⇒ detected-not-offered; binary ∩ marker ⇒ OFFERED config row
//      (project-local bin outranks PATH)
//   C. the offered row drives the REAL pipeline: manager init registers it,
//      first use SPAWNS it, initialize completes, a request round-trips
//   R. routing: diagnosticsOnly claimants are never the navigation primary
//      (but own the extension when alone); disabled rows are dropped
//   L. lifecycle: idleTimeoutMs stops an idle server (lazy restart works);
//      a failed initialize backs off FAST and restart() clears the backoff
//   O. the op gaps: capabilities dumps the claimant's advertisement;
//      rawRequest refuses edit-class methods by name and answers others
//      raw; rawRequest is write-classed unconditionally
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

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

// ── scratch workspace + PATH shim BEFORE imports ────────────────────────────
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-catalogue-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'lsp-catalogue-home-'))
const shimBin = path.join(scratch, 'shim-bin')
mkdirSync(shimBin)
writeFileSync(path.join(scratch, 'Cargo.toml'), '[package]\nname = "proof"\n')
writeFileSync(path.join(scratch, 'x.rs'), 'fn main() {}\n')
const shim = path.join(shimBin, 'rust-analyzer')
writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`
delete process.env.MERCURY_LSP
process.chdir(scratch)

// Two env servers claiming one neutral extension: a linter-class row first,
// a full row second; a third row disabled outright.
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

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

console.log('— T. the data table —')
const { SERVER_CATALOGUE, probeCatalogueEntry, catalogueServerConfigs, serverCatalogueRecords } =
  await import('../../src/services/lsp/serverCatalogue.js')
{
  const ids = new Set(SERVER_CATALOGUE.map(e => e.id))
  check('ids are unique', ids.size === SERVER_CATALOGUE.length)
  check('every row has binaries + a remedy', SERVER_CATALOGUE.every(e => e.binaries.length > 0 && e.remedy.length > 0))
  check(
    'every extension key is dotted and mapped to a language id',
    SERVER_CATALOGUE.every(e =>
      Object.entries(e.extensionToLanguage).every(([k, v]) => k.startsWith('.') && v.length > 0),
    ),
  )
  check('the mainstream set is present (rust/go/zig/java/kotlin/c#/swift/ruby/php/lua/bash/yaml/terraform/dockerfile/elixir)',
    ['rust-analyzer', 'gopls', 'zls', 'jdtls', 'kotlin-language-server', 'csharp', 'sourcekit-lsp', 'ruby-lsp', 'intelephense', 'lua-language-server', 'bash-language-server', 'yaml-language-server', 'terraform-ls', 'docker-langserver', 'elixir-ls'].every(id => ids.has(id)))
}

console.log('— D. detection truth —')
{
  const rust = SERVER_CATALOGUE.find(e => e.id === 'rust-analyzer')!
  const gopls = SERVER_CATALOGUE.find(e => e.id === 'gopls')!
  const probe = probeCatalogueEntry(rust)
  check('binary ∩ marker probes offered material', probe.binaryPath === shim && probe.rootMatched, JSON.stringify(probe))
  const configs = catalogueServerConfigs()
  check('the offered row joins the config map', 'catalogue:rust-analyzer' in configs, Object.keys(configs).join(','))
  check('the offered row carries the resolved binary + markers', configs['catalogue:rust-analyzer']?.command === shim && Array.isArray(configs['catalogue:rust-analyzer']?.rootMarkers))
  const goProbe = probeCatalogueEntry(gopls)
  const goOffered = 'catalogue:gopls' in configs
  if (goProbe.binaryPath) {
    check('gopls binary without go.mod is NOT offered', !goOffered && !goProbe.rootMatched, JSON.stringify(goProbe))
  } else {
    check('no gopls binary ⇒ not offered', !goOffered)
  }
  const records = serverCatalogueRecords()
  const rustRecord = records.find(r => r.id === 'catalogue:lsp:rust-analyzer')
  check('/health row says offered with the spawn story', rustRecord?.state === 'configured' && /offered/.test(rustRecord?.label ?? '') && /spawns lazily/.test(rustRecord?.detail ?? ''), JSON.stringify(rustRecord))
  const missing = records.find(r => r.state === 'unavailable')
  check('an absent binary reads unavailable WITH its remedy', missing !== undefined && typeof missing.remedy === 'string', JSON.stringify(missing?.id))
  // Project-local outranks PATH: drop a second fake into node_modules/.bin.
  const localBin = path.join(scratch, 'node_modules', '.bin')
  mkdirSync(localBin, { recursive: true })
  const localShim = path.join(localBin, 'rust-analyzer')
  writeFileSync(localShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}"\n`)
  chmodSync(localShim, 0o755)
  const localProbe = probeCatalogueEntry(rust)
  check('project-local bin outranks PATH', localProbe.binaryPath === localShim && localProbe.binarySource === 'project-local', JSON.stringify(localProbe))
}

console.log('— C. the offered row through the REAL pipeline —')
const mgrModule = await import('../../src/services/lsp/manager.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
check('manager init succeeds', mgrModule.getInitializationStatus().status === 'success', JSON.stringify(mgrModule.getInitializationStatus()))
const manager = mgrModule.getLspServerManager()!
{
  const names = [...manager.getAllServers().keys()]
  check('catalogue row registered', names.includes('catalogue:rust-analyzer'), names.join(','))
  check('disabled env row dropped', !names.includes('env:ghost'), names.join(','))
  const rsFile = path.join(scratch, 'x.rs')
  const server = await manager.ensureServerStarted(rsFile)
  check('first use SPAWNS the catalogue server (initialize completed)', server?.state === 'running', server?.state)
  const answer = await manager.sendRequest<unknown>(rsFile, 'textDocument/hover', {
    textDocument: { uri: 'file://' + rsFile },
    position: { line: 0, character: 0 },
  })
  check('a request round-trips through the spawned server', answer === null, JSON.stringify(answer))
}

console.log('— R. routing: the linter class + precedence —')
{
  const qq = path.join(scratch, 'a.qq')
  writeFileSync(qq, 'x\n')
  const claimants = manager.getServersForFile(qq).map(s => s.name)
  check('both env claimants indexed in insertion order', claimants.join(',') === 'env:linty,env:fully', claimants.join(','))
  check('the diagnosticsOnly claimant is NOT the primary', manager.getServerForFile(qq)?.name === 'env:fully')
  const rr = path.join(scratch, 'b.rr')
  writeFileSync(rr, 'x\n')
  check('a linter ALONE still owns its extension (diagnostics deserve an owner)', manager.getServerForFile(rr)?.name === 'env:linty')
}

console.log('— L. idle timeout + init-failure backoff —')
const { createLSPServerInstance } = await import('../../src/services/lsp/LSPServerInstance.js')
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
  check('idle server starts', idle.state === 'running')
  await new Promise(r => setTimeout(r, 500))
  check('idleTimeoutMs stopped the idle server', idle.state === 'stopped', idle.state)
  await idle.start()
  check('lazy restart after idle stop works', idle.state === 'running')
  await idle.stop()

  // A shim-class failure: prints WHY to stderr and exits. The death race
  // must fail the handshake in milliseconds CARRYING those words — never by
  // burning the whole startup timeout (the live rust-analyzer rustup-shim
  // finding).
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
  check('doomed initialize fails FAST (never the startup timeout)', firstError.length > 0 && firstMs < 3_000, `${firstMs}ms: ${firstError}`)
  check("the failure carries the child's own stderr (the honest remedy)", /server said: .*component not installed/.test(firstError), firstError)
  let secondError = ''
  const t1 = Date.now()
  await doomed.start().catch(e => (secondError = (e as Error).message))
  const secondMs = Date.now() - t1
  check('the second attempt refuses inside the backoff window', /backing off/.test(secondError) && secondMs < 100, `${secondMs}ms: ${secondError}`)
  let thirdError = ''
  await doomed.restart().catch(e => (thirdError = (e as Error).message))
  check('restart() clears the backoff (a real attempt runs again)', !/backing off/.test(thirdError) && thirdError.length > 0, thirdError)
}

console.log('— O. capabilities + rawRequest —')
const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { LSPTool } = await import('../../src/tools/LSPTool/LSPTool.js')
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
  check('rawRequest refuses the edit-class method by name', refused.effect.outcome === 'failed' && /edit-class/.test(refused.result) && /codeActions/.test(refused.result), refused.result.slice(0, 160))
  const renameRefused = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'textDocument/rename', params: '{}' }))
  check('rawRequest points rename at the typed op', renameRefused.effect.outcome === 'failed' && /rename operation/.test(renameRefused.result), renameRefused.result.slice(0, 160))
  const raw = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'textDocument/documentHighlight', params: JSON.stringify({ textDocument: { uri: 'file://' + rsFile }, position: { line: 0, character: 0 } }) }))
  check('a non-edit method answers raw (nothing applied)', raw.effect.outcome === 'succeeded' && /nothing was applied/.test(raw.result), raw.result.slice(0, 160))
  const badJson = await runMercuryLspOp(envFor({ operation: 'rawRequest', filePath: rsFile, method: 'textDocument/documentHighlight', params: '{nope' }))
  check('malformed params JSON refuses typed', badJson.effect.outcome === 'failed' && /not valid JSON/.test(badJson.result))
  check('rawRequest is write-classed unconditionally', LSPTool.isReadOnly({ operation: 'rawRequest', filePath: rsFile, method: 'x' } as never) === false)
  check('capabilities stays read-only', LSPTool.isReadOnly({ operation: 'capabilities', filePath: rsFile } as never) === true)
}

await mgrModule.shutdownLspServerManager()
console.log('')
if (failures > 0) {
  console.error(`prove-lsp-catalogue: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-catalogue: GREEN — the catalogue offers honestly, routes linters aside, and the escape hatch cannot write')
