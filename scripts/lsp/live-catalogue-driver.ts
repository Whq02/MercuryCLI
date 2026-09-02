#!/usr/bin/env bun
// live-catalogue-driver — the REAL-boot catalogue drive: on a scratch Cargo
// project, the catalogue OFFERS the host's real rust-analyzer (root-marker ∩
// binary), the manager spawns it lazily, and a real definition answers
// through it; the /health rows state every offer and every honest why-not.
// RUN_LIVE=1 keeps it explicit (host-dependent: needs rust-analyzer).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.env.RUN_LIVE !== '1') {
  console.log('live-catalogue-driver: real rust-analyzer catalogue smoke — set RUN_LIVE=1 to run (never gate-joined).')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'live-catalogue-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'live-catalogue-home-'))
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS
process.chdir(scratch)

writeFileSync(path.join(scratch, 'Cargo.toml'), '[package]\nname = "live_proof"\nversion = "0.1.0"\nedition = "2021"\n')
mkdirSync(path.join(scratch, 'src'))
const mainRs = path.join(scratch, 'src', 'main.rs')
writeFileSync(mainRs, 'fn compute(n: i32) -> i32 {\n    n * 2\n}\n\nfn main() {\n    let v = compute(21);\n    println!("{}", v);\n}\n')

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail = 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { serverCatalogueRecords } = await import('../../src/services/lsp/serverCatalogue.js')
const records = serverCatalogueRecords()
const rust = records.find(r => r.id === 'catalogue:lsp:rust-analyzer')
console.log('\n===== /health CATALOGUE ROWS (first 6) =====')
for (const r of records.slice(0, 6)) console.log(`  ${r.state.padEnd(12)} ${r.label} — ${r.detail.slice(0, 90)}${r.remedy ? ` [remedy: ${r.remedy.slice(0, 40)}…]` : ''}`)
console.log('============================================\n')
check('rust-analyzer reads OFFERED on the Cargo scratch', rust?.state === 'configured' && /offered/.test(rust?.label ?? ''), JSON.stringify(rust))
check('an absent server reads unavailable WITH its remedy (the honest why-not)', records.some(r => r.state === 'unavailable' && typeof r.remedy === 'string'))

const mgrModule = await import('../../src/services/lsp/manager.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
const manager = mgrModule.getLspServerManager()!
check('the catalogue row registered with the manager', [...manager.getAllServers().keys()].includes('catalogue:rust-analyzer'), [...manager.getAllServers().keys()].join(','))

// Viability probe: a rustup SHIM for an uninstalled component passes the
// PATH probe but cannot run — the degraded leg proves Mercury fails FAST
// with the shim's own words instead of eating the startup timeout.
const { spawnSync } = await import('node:child_process')
const probe = spawnSync('rust-analyzer', ['--version'], { timeout: 10_000, encoding: 'utf8', env: { ...process.env } })
if (probe.status !== 0) {
  console.log(`\nrust-analyzer on this host is not viable (${(probe.stderr ?? '').trim().slice(0, 120)}) — driving the DEGRADED leg.`)
  const instance = manager.getAllServers().get('catalogue:rust-analyzer')!
  let failure = ''
  const t0 = Date.now()
  await instance.start().catch(e => (failure = (e as Error).message))
  const ms = Date.now() - t0
  console.log(`start failed in ${ms}ms: ${failure}`)
  check('the doomed spawn failed FAST (not the 30s startup timeout)', failure.length > 0 && ms < 5_000, `${ms}ms`)
  check("the failure carries the shim's own explanation", /server said: .*Unknown binary|server said: .*rust-analyzer/.test(failure), failure)
  await mgrModule.shutdownLspServerManager()
  console.log('')
  if (fail) {
    console.log('live-catalogue-driver: RED')
    process.exit(1)
  }
  console.log('live-catalogue-driver: GREEN (degraded leg) — the offer was honest and the failure named itself fast')
  process.exit(0)
}

await manager.openFile(mainRs, readFileSync(mainRs, 'utf8'))
const uri = pathToFileURL(mainRs).href
// rust-analyzer indexes briefly — retry the definition until it answers.
let definition: unknown = null
for (let i = 0; i < 40; i++) {
  definition = await manager
    .sendRequest<unknown>(mainRs, 'textDocument/definition', {
      textDocument: { uri },
      position: { line: 5, character: 13 }, // `compute` at the call site
    })
    .catch(() => null)
  const hits = Array.isArray(definition) ? definition : definition ? [definition] : []
  if (hits.length > 0) break
  await new Promise(r => setTimeout(r, 250))
}
const hits = (Array.isArray(definition) ? definition : definition ? [definition] : []) as Array<{
  uri?: string
  targetUri?: string
  range?: { start?: { line?: number } }
  targetRange?: { start?: { line?: number } }
}>
console.log('definition answer: ' + JSON.stringify(hits).slice(0, 200))
const hitLine = hits[0]?.range?.start?.line ?? hits[0]?.targetRange?.start?.line
check(
  'the REAL rust-analyzer answered the definition (compute at line 1/0-based 0)',
  hits.length > 0 && hitLine === 0,
  JSON.stringify(hits).slice(0, 160),
)

await mgrModule.shutdownLspServerManager()
console.log('')
if (fail) {
  console.log('live-catalogue-driver: RED')
  process.exit(1)
}
console.log('live-catalogue-driver: GREEN — the catalogue offered, spawned, and a real server answered')
