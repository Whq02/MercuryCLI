#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

process.env.MERCURY_HOME = mkdtempSync(path.join(tmpdir(), 'live-smoke-home-'))


if (process.env.RUN_LIVE !== '1') {
  console.log('live-clangd-driver: RUN_LIVE!=1 — skipping (live smoke only)')
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { probeBuiltinClangd, MERCURY_CLANGD_SERVER_NAME } = await import(
  '../../src/services/lsp/clangdLane.js'
)
const clangd = probeBuiltinClangd()
if (!clangd.available) {
  console.log(`live-clangd-driver: ${clangd.reason} — skipping`)
  process.exit(0)
}
console.log(`live clangd: ${clangd.clangdPath}`)

const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { createLSPServerManager } = await import(
  '../../src/services/lsp/LSPServerManager.js'
)

const proj = mkdtempSync(path.join(tmpdir(), 'clangd-live-'))
mkdirSync(proj, { recursive: true })
writeFileSync(path.join(proj, 'compile_flags.txt'), '-std=c++17\n')
writeFileSync(
  path.join(proj, 'util.h'),
  '#pragma once\nint add(int a, int b);\n',
)
writeFileSync(
  path.join(proj, 'util.cpp'),
  '#include "util.h"\nint add(int a, int b) { return a + b; }\n',
)
const mainCpp = path.join(proj, 'main.cpp')
const mainSrc =
  '#include "util.h"\nint main() {\n  return add(1);\n}\n'
writeFileSync(mainCpp, mainSrc)

await runWithCwdOverride(proj, async () => {
  const manager = createLSPServerManager()
  await manager.initialize()
  const server = manager.getServerForFile(mainCpp)
  check(
    'mercury-clangd claims .cpp in the scratch project',
    server?.name === MERCURY_CLANGD_SERVER_NAME,
    server?.name,
  )
  if (!server) process.exit(1)

  const diagnosticsByUri = new Map<string, Array<{ message: string }>>()
  await manager.ensureServerStarted(mainCpp)
  server.onNotification('textDocument/publishDiagnostics', params => {
    const p = params as { uri?: string; diagnostics?: Array<{ message: string }> }
    if (p.uri) diagnosticsByUri.set(p.uri, p.diagnostics ?? [])
  })

  await manager.openFile(mainCpp, mainSrc)

  const definition = await manager.sendRequest<
    Array<{ uri?: string; targetUri?: string }>
  >(mainCpp, 'textDocument/definition', {
    textDocument: { uri: pathToFileURL(mainCpp).href },
    position: { line: 2, character: 9 },
  })
  const defUri = definition?.[0]?.uri ?? definition?.[0]?.targetUri ?? ''
  check('definition of add() lands in util.h', defUri.endsWith('util.h'), defUri)

  const utilCpp = path.join(proj, 'util.cpp')
  await manager.openFile(utilCpp, '#include "util.h"\nint add(int a, int b) { return a + b; }\n')
  const pair = await manager.sendRequest<string | null>(
    utilCpp,
    'textDocument/switchSourceHeader',
    { uri: pathToFileURL(utilCpp).href },
  )
  check('switchSourceHeader pairs util.cpp → util.h', (pair ?? '').endsWith('util.h'), String(pair))

  const deadline = Date.now() + 20_000
  let mainDiags: Array<{ message: string }> | undefined
  while (Date.now() < deadline) {
    mainDiags = diagnosticsByUri.get(pathToFileURL(mainCpp).href)
    if (mainDiags && mainDiags.length > 0) break
    await new Promise(res => setTimeout(res, 200))
  }
  check(
    'publishDiagnostics carries the too-few-arguments error',
    (mainDiags ?? []).some(d => /too few arguments|no matching function/i.test(d.message)),
    JSON.stringify(mainDiags?.map(d => d.message) ?? []),
  )

  await manager.shutdown()
})

rmSync(proj, { recursive: true, force: true })

if (failures > 0) {
  console.error(`live-clangd-driver: RED (${failures})`)
  process.exit(1)
}
console.log('live-clangd-driver: GREEN — real clangd through the production manager')
