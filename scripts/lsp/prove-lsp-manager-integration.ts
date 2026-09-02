
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dir, '../..')
const fixture = path.join(repo, 'scripts/lsp/fixtures/proj')
const sidecarEntry = path.join(repo, 'src/services/lsp/tsSidecar/entry.ts')

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

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

{
  delete process.env.MERCURY_LSP_SIDECAR_ENTRY
  delete process.env.MERCURY_LSP_SIDECAR_ENTRY
  const { probeBuiltinTsServer } = await import(
    '../../src/services/lsp/builtinServers.js'
  )
  const probe = probeBuiltinTsServer()
  check(
    'respawn safety: unrecognized argv[1] (this proof) is REFUSED, with the override named',
    probe.available === false &&
      (probe.reason ?? '').includes('not a Mercury entry') &&
      (probe.reason ?? '').includes('MERCURY_LSP_SIDECAR_ENTRY'),
    probe.reason,
  )
}

process.env.MERCURY_LSP_SIDECAR_ENTRY = sidecarEntry
const mgrModule = await import('../../src/services/lsp/manager.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
check(
  'manager init succeeds',
  mgrModule.getInitializationStatus().status === 'success',
  JSON.stringify(mgrModule.getInitializationStatus()),
)

const manager = mgrModule.getLspServerManager()
if (!manager) {
  console.error('prove-lsp-manager-integration: RED (no manager)')
  process.exit(1)
}
check(
  'config source: mercury-ts registered via the merge',
  [...manager.getAllServers().keys()].includes('mercury-ts'),
  [...manager.getAllServers().keys()].join(','),
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
  check('spawn+request pipeline ran', false, e instanceof Error ? e.message : String(e))
}
check(
  'cross-file definition through the manager lands in lib.ts',
  defs.some(d => d.uri === pathToFileURL(libPath).href),
  JSON.stringify(defs).slice(0, 160),
)
check('isLspConnected() is true with the server running', mgrModule.isLspConnected() === true)

{
  check('getDocumentVersion: open doc has a version', typeof manager.getDocumentVersion(appPath) === 'number')
  const libText = readFileSync(libPath, 'utf8')
  await manager.openFile(libPath, libText)
  const closed = await manager.closeAllFiles()
  check(`closeAllFiles closed both docs (${closed})`, closed === 2)
  check('closed docs no longer read open', manager.isFileOpen(appPath) === false && manager.isFileOpen(libPath) === false)
  check('closed doc has no version', manager.getDocumentVersion(appPath) === undefined)
  await manager.openFile(appPath, appText)
  check('re-open after release works', manager.isFileOpen(appPath) === true)
}

await mgrModule.shutdownLspServerManager()
check(
  'shutdown: manager cleared + status not-started',
  mgrModule.getLspServerManager() === undefined &&
    mgrModule.getInitializationStatus().status === 'not-started',
)

delete process.env.MERCURY_LSP_SIDECAR_ENTRY

if (failures > 0) {
  console.error(`prove-lsp-manager-integration: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-manager-integration: GREEN')
process.exit(0)
