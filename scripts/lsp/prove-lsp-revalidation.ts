
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

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

process.env.MERCURY_LSP_SIDECAR_ENTRY = sidecarEntry
const mgrModule = await import('../../src/services/lsp/manager.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
const manager = mgrModule.getLspServerManager()
if (!manager) {
  console.error('prove-lsp-revalidation: RED (no manager)')
  process.exit(1)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'lsp-reval-'))

console.log('§1 an out-of-band overwrite resyncs — and the server answers from disk')
const revalPath = path.join(scratch, 'reval.ts')
const v1 = 'export const one = 1\n'
writeFileSync(revalPath, v1)
await manager.openFile(revalPath, v1)
const versionBefore = manager.getDocumentVersion(revalPath)
const v2 = 'export function madeFresh(): number {\n  return 2\n}\nexport const one = 1\n'
writeFileSync(revalPath, v2)
const report1 = await manager.revalidateOpenDocuments()
check('the resync is RECORDED', report1.resynced.includes(revalPath), JSON.stringify(report1))
check('the document version advanced (a didChange was pushed)', (manager.getDocumentVersion(revalPath) ?? 0) > (versionBefore ?? 0))
let symbols: Array<{ name: string }> = []
try {
  symbols =
    (await manager.sendRequest(revalPath, 'textDocument/documentSymbol', {
      textDocument: { uri: (await import('node:url')).pathToFileURL(revalPath).href },
    })) ?? []
} catch (e) {
  check('documentSymbol pipeline ran', false, e instanceof Error ? e.message : String(e))
}
check(
  'the server answers from the ON-DISK bytes (the rewrite-only symbol resolves)',
  JSON.stringify(symbols).includes('madeFresh'),
  JSON.stringify(symbols).slice(0, 160),
)

console.log('§2 200 unchanged documents: zero resyncs, zero closes')
const bulkDir = path.join(scratch, 'bulk')
mkdirSync(bulkDir)
const bulkPaths: string[] = []
for (let i = 0; i < 200; i++) {
  const p = path.join(bulkDir, `bulk-${i}.ts`)
  const text = `export const bulk${i} = ${i}\n`
  writeFileSync(p, text)
  await manager.openFile(p, text)
  bulkPaths.push(p)
}
const sampleVersions = bulkPaths.slice(0, 5).map(p => manager.getDocumentVersion(p))
const report2 = await manager.revalidateOpenDocuments()
check('nothing resynced, nothing closed', report2.resynced.length === 0 && report2.closed.length === 0, JSON.stringify({ resynced: report2.resynced.length, closed: report2.closed.length, failed: report2.failed.length }))
check('every open document was checked (one stat each by construction)', report2.checked >= 201, String(report2.checked))
check('zero notifications: sampled versions unmoved', bulkPaths.slice(0, 5).every((p, i) => manager.getDocumentVersion(p) === sampleVersions[i]))

console.log('§3 an out-of-band delete closes the document; the pipeline still serves')
rmSync(revalPath)
const report3 = await manager.revalidateOpenDocuments()
check('the deleted document is closed and recorded', report3.closed.includes(revalPath) && manager.isFileOpen(revalPath) === false, JSON.stringify(report3.closed))
let afterDelete: Array<{ name: string }> = []
try {
  afterDelete =
    (await manager.sendRequest(bulkPaths[0]!, 'textDocument/documentSymbol', {
      textDocument: { uri: (await import('node:url')).pathToFileURL(bulkPaths[0]!).href },
    })) ?? []
  check('the next operation completes with no unhandled error', true)
} catch (e) {
  check('the next operation completes with no unhandled error', false, e instanceof Error ? e.message : String(e))
}
check('…and still answers real content', JSON.stringify(afterDelete).includes('bulk0'), JSON.stringify(afterDelete).slice(0, 120))

console.log('§4 an oversized rewrite is skipped as failed; the document stands')
const bigPath = path.join(scratch, 'big.ts')
writeFileSync(bigPath, 'export const small = 1\n')
await manager.openFile(bigPath, 'export const small = 1\n')
const bigVersion = manager.getDocumentVersion(bigPath)
writeFileSync(bigPath, `// ${'x'.repeat(11_000_000)}\n`)
const report4 = await manager.revalidateOpenDocuments()
check('the oversized rewrite lands in failed, never half-pushed', report4.failed.includes(bigPath), JSON.stringify({ failed: report4.failed.length }))
check('the document is left as it was', manager.getDocumentVersion(bigPath) === bigVersion)

console.log('§5 the wiring')
const ops = readFileSync(path.join(repo, 'src/tools/LSPTool/mercuryOps.ts'), 'utf8')
check('runMercuryLspOp revalidates at op entry', /runMercuryLspOp[\s\S]{0,900}revalidateOpenDocuments/.test(ops))
const drain = readFileSync(path.join(repo, 'src/utils/attachments/diagnostics.ts'), 'utf8')
check('the diagnostics drain revalidates before delivering', drain.includes('revalidateOpenDocuments'))
const mgrSrc = readFileSync(path.join(repo, 'src/services/lsp/LSPServerManager.ts'), 'utf8')
check('the tracking entry carries the disk stamp', mgrSrc.includes('disk?: { mtimeMs: number; size: number }'))

await mgrModule.shutdownLspServerManager()
rmSync(scratch, { recursive: true, force: true })
delete process.env.MERCURY_LSP_SIDECAR_ENTRY

if (failures > 0) {
  console.error(`prove-lsp-revalidation: RED (${failures})`)
  process.exit(1)
}
console.log('prove-lsp-revalidation: GREEN')
process.exit(0)
