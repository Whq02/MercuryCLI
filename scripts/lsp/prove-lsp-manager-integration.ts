
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dir, '../..')
const fixture = path.join(repo, 'scripts/lsp/fixtures/proj')
const sidecarEntry = path.join(repo, 'src/integrations/lsp/ts-sidecar/entry.ts')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS
process.chdir(fixture)

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

{
  delete process.env.MERCURY_LSP_SIDECAR_ENTRY
  const { probeBuiltinTsServer } = await import(
    '../../src/integrations/lsp/builtinServers.js'
  )
  const probe = probeBuiltinTsServer()
  check(
    'respawn safety: unrecognized argv[1] (this proof) is REFUSED, with the override named',
    probe.available === false &&
      (probe.reason ?? '').includes('not a Mercury entry') &&
      (probe.reason ?? '').includes('MERCURY_LSP_SIDECAR_ENTRY'),
    `probeBuiltinTsServer in src/integrations/lsp/builtinServers.ts must refuse an unrecognized argv[1] and name MERCURY_LSP_SIDECAR_ENTRY in its reason: ${probe.reason}`,
  )
}

process.env.MERCURY_LSP_SIDECAR_ENTRY = sidecarEntry
process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  brokenLinter: { command: path.join(repo, 'missing-linter-fixture'), diagnosticsOnly: true, extensionToLanguage: { '.syncproof': 'syncproof' } },
  semantic: { command: process.execPath, args: [path.join(repo, 'scripts/lsp/fixtures/fake-lsp-server.mjs')], extensionToLanguage: { '.syncproof': 'syncproof' } },
})
const mgrModule = await import('../../src/integrations/lsp/serverManagerLifecycle.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
check(
  'manager init succeeds',
  mgrModule.getInitializationStatus().status === 'success',
  `initializeLspServerManager in src/integrations/lsp/serverManagerLifecycle.ts did not reach success: ${JSON.stringify(mgrModule.getInitializationStatus())}`,
)

const manager = mgrModule.getLspServerManager()
if (!manager) {
  console.error('prove-lsp-manager-integration: RED (no manager)')
  process.exit(1)
}
check(
  'config source: mercury-ts registered via the merge',
  [...manager.getAllServers().keys()].includes('mercury-ts'),
  `the server config merge behind src/integrations/lsp/serverManagerLifecycle.ts must register mercury-ts, registered: ${[...manager.getAllServers().keys()].join(',')}`,
)

const appPath = path.join(fixture, 'src/app.ts')
const libPath = path.join(fixture, 'src/lib.ts')
const appText = readFileSync(appPath, 'utf8')

let defs: { uri: string; range: { start: { line: number } } }[] = []
try {
  await manager.openFile(appPath, appText)
  const useIdx = appText.indexOf('makeGreeting(n)')
  const before = appText.slice(0, useIdx)
  const line = (before.match(/\n/g) ?? []).length
  const character = useIdx - (before.lastIndexOf('\n') + 1)
  defs =
    (await manager.sendRequest(appPath, 'textDocument/definition', {
      textDocument: { uri: pathToFileURL(appPath).href },
      position: { line, character },
    })) ?? []
} catch (e) {
  check('spawn+request pipeline ran', false, `openFile or sendRequest in src/integrations/lsp/LSPServerManager.ts threw: ${e instanceof Error ? e.message : String(e)}`)
}
check(
  'cross-file definition through the manager lands in lib.ts',
  defs.some(d => d.uri === pathToFileURL(libPath).href),
  `sendRequest in src/integrations/lsp/LSPServerManager.ts must return the definition in src/lib.ts of the fixture project: ${JSON.stringify(defs).slice(0, 160)}`,
)
check('isLspConnected() is true with the server running', mgrModule.isLspConnected() === true, 'isLspConnected in src/integrations/lsp/serverManagerLifecycle.ts must report true while a server is running')

{
  check('getDocumentVersion: open doc has a version', typeof manager.getDocumentVersion(appPath) === 'number', 'getDocumentVersion in src/integrations/lsp/LSPServerManager.ts must return a number for an opened file')
  const libText = readFileSync(libPath, 'utf8')
  await manager.openFile(libPath, libText)
  const closed = await manager.closeAllFiles()
  check(`closeAllFiles closed both docs (${closed})`, closed === 2, `closeAllFiles in src/integrations/lsp/LSPServerManager.ts must close both opened documents, closed ${closed}`)
  check('closed docs no longer read open', manager.isFileOpen(appPath) === false && manager.isFileOpen(libPath) === false, 'closeAllFiles in src/integrations/lsp/LSPServerManager.ts must also clear what isFileOpen reads')
  check('closed doc has no version', manager.getDocumentVersion(appPath) === undefined, 'closeAllFiles in src/integrations/lsp/LSPServerManager.ts must clear the document version')
  await manager.openFile(appPath, appText)
  check('re-open after release works', manager.isFileOpen(appPath) === true, 'openFile in src/integrations/lsp/LSPServerManager.ts must open a file again after closeAllFiles')
}

const syncPath = path.join(process.env.MERCURY_CONFIG_DIR!, 'priority.syncproof')
let syncError: unknown
try { await manager.openFile(syncPath, 'fixture') } catch (error) { syncError = error }
check('a broken diagnostics-only first claimant does not block the semantic primary from opening', syncError === undefined && manager.getServerForFile(syncPath)?.name === 'env:semantic' && manager.isFileOpen(syncPath), `openFile and getServerForFile in src/integrations/lsp/LSPServerManager.ts must skip a broken diagnostics-only claimant and use the semantic server: ${String(syncError ?? '')}`)
await manager.closeFile(syncPath).catch(() => {})

await mgrModule.shutdownLspServerManager()
check(
  'shutdown: manager cleared + status not-started',
  mgrModule.getLspServerManager() === undefined &&
    mgrModule.getInitializationStatus().status === 'not-started',
  'shutdownLspServerManager in src/integrations/lsp/serverManagerLifecycle.ts must clear the manager and reset the status to not-started',
)

delete process.env.MERCURY_LSP_SIDECAR_ENTRY

if (failures > 0) {
  console.error(`prove-lsp-manager-integration: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-manager-integration: GREEN')
process.exit(0)
