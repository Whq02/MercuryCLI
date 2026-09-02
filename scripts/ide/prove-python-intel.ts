#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-python-intel.ts
//  PROOF (LIVE): the Python intelligence lane end to end — the REAL
//  LSPServerManager driving the REAL vendored pyright-langserver over a
//  fixture project. No mocks on the language-server side.
//
//    (1) REGISTRATION — mercury-pyright claims .py as the routed semantic
//        owner through the real manager (multi-claimant list intact).
//    (2) PUSH DIAGNOSTICS — opening a file with a REAL type error publishes
//        pyright diagnostics into the production registry (source identity
//        preserved).
//    (3) NAVIGATION — cross-file definition + hover through the manager's
//        production request path.
//    (4) RENAME — preview lists cross-file edits; apply writes through the
//        REAL anchored/permissioned/drift-checked transaction and the
//        post-apply stabilization runs (push quiet-window lane).
//    (5) FORMAT HONESTY — formatDocument on .py: with no ruff installed the
//        answer is the PRECISE refusal naming what was checked + the ruff
//        remedy; with ruff installed it formats through the same
//        transaction. Both arms honest, chosen by the machine.
//    (6) HYGIENE — serverStatus rows; shutdown leaves no server running.
//
//  Machine dependence: the pyright vendor cache (fetch-pyright) — absent ⇒
//  LOUD skip with the remedy. Ruff legs branch honestly on availability.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-python-intel.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CACHE = path.join(ROOT, 'vendor', 'pyright', 'extracted')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

console.log('============================================================')
console.log(' python intel LIVE — real manager · real vendored pyright')
console.log('============================================================')

if (!existsSync(path.join(CACHE, 'langserver.index.js'))) {
  console.log('\n  [SKIP — LOUD] vendor/pyright/extracted absent — the live lane journey needs it.')
  console.log('  remedy: bun run scripts/vendor/fetch-pyright.ts')
  process.exit(0)
}

process.env.MERCURY_PYRIGHT_VENDOR_DIR = CACHE
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_PYTHON

// Fixture project INSIDE the repo cwd (the write-scope contract) — the
// gitignored .tmp-lsp-proof- prefix keeps the tree clean.
const proj = mkdtempSync(path.join(process.cwd(), '.tmp-lsp-proof-pyintel-'))
const libPy = path.join(proj, 'lib.py')
const mainPy = path.join(proj, 'main.py')
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "intel-fixture"\nversion = "0.0.1"\n')
writeFileSync(libPy, 'def helper(x: int) -> int:\n    return x * 2\n')
writeFileSync(mainPy, 'from lib import helper\n\nvalue: str = helper(3)\n')

// chdir BEFORE any src import: utils/cwd captures its state on first load,
// and the pyright lane's workspaceFolder derives from getCwd() at config
// build — a late chdir would hand pyright the REPO as its workspace (imports
// then resolve against the wrong root and cross-file rename finds nothing).
process.chdir(proj)

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { createLSPServerManager } = await import('../../src/services/lsp/LSPServerManager.js')
const { subscribeLSPDiagnosticPublish } = await import('../../src/services/lsp/LSPDiagnosticRegistry.js')
// The production publish wiring (manager.ts registers these on the singleton
// after initialize) — the proof replicates the SAME seam on its manager.
const { registerLSPNotificationHandlers } = await import('../../src/services/lsp/passiveFeedback.js')
const { runMercuryLspOp } = await import('../../src/tools/LSPTool/mercuryOps.js')
const { probeRuff } = await import('../../src/services/lsp/ruffLane.js')

const PERMISSIVE_CTX = {
  mode: 'implement',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
  shouldAvoidPermissionPrompts: false,
}
const tool = { name: 'LSP', getPath: (i: { filePath: string }) => i.filePath }
const context = { getAppState: () => ({ toolPermissionContext: PERMISSIVE_CTX }) }
const opEnv = (input: Record<string, unknown>, absolutePath: string) => ({
  input: input as never,
  absolutePath,
  cwd: proj,
  manager,
  tool: tool as never,
  context: context as never,
})

const manager = createLSPServerManager()
const published: Array<{ serverName: string; files: Array<{ uri: string; diagnostics: Array<{ message: string; severity?: string }> }> }> = []
const unsubscribe = subscribeLSPDiagnosticPublish(e => published.push(e as never))

try {
  await manager.initialize()
  registerLSPNotificationHandlers(manager)

  section('(1) registration — the routed semantic owner')
  {
    const claimants = manager.getServersForFile(mainPy).map(s => s.name)
    check('mercury-pyright is the FIRST .py claimant', claimants[0] === 'mercury-pyright', claimants.join(', '))
    console.log(`  (claimants: ${claimants.join(', ') || 'none'})`)
  }

  section('(2) push diagnostics — a REAL type error reaches the registry')
  {
    await manager.openFile(mainPy, readFileSync(mainPy, 'utf8'))
    const deadline = Date.now() + 30_000
    let hit: { message: string } | undefined
    while (Date.now() < deadline && !hit) {
      hit = published
        .filter(p => p.serverName === 'mercury-pyright')
        .flatMap(p => p.files)
        .filter(f => f.uri.includes('main.py'))
        .flatMap(f => f.diagnostics)
        .find(d => /not assignable|incompatible/i.test(d.message))
      if (!hit) await new Promise(r => setTimeout(r, 150))
    }
    check('pyright publishes the str↚int assignment error (source identity intact)', hit !== undefined, published.length ? JSON.stringify(published.at(-1)).slice(0, 200) : 'nothing published in 30s')
  }

  section('(3) navigation — cross-file definition + hover (production path)')
  {
    const { pathToFileURL } = await import('node:url')
    const defs = await manager.sendRequest<Array<{ uri?: string; targetUri?: string }>>(mainPy, 'textDocument/definition', {
      textDocument: { uri: pathToFileURL(mainPy).href },
      position: { line: 2, character: 14 }, // helper(3) callee
    })
    const target = (defs ?? [])[0]
    const uri = target?.uri ?? target?.targetUri ?? ''
    check('definition of helper resolves into lib.py', uri.includes('lib.py'), JSON.stringify(defs).slice(0, 160))

    const hover = await manager.sendRequest<{ contents?: unknown }>(mainPy, 'textDocument/hover', {
      textDocument: { uri: pathToFileURL(mainPy).href },
      position: { line: 2, character: 14 },
    })
    check('hover carries the helper signature', JSON.stringify(hover?.contents ?? '').includes('(x: int) -> int'), JSON.stringify(hover?.contents ?? null).slice(0, 140))
  }

  section('(4) rename — preview then the REAL apply transaction')
  {
    const preview = await runMercuryLspOp(opEnv(
      { operation: 'rename', filePath: libPy, line: 1, character: 5, newName: 'double_it' },
      libPy,
    ))
    check('rename preview spans BOTH files', preview.fileCount === 2 && preview.applied === false, `files=${preview.fileCount} result=${preview.result.split('\n')[0]}`)

    const apply = await runMercuryLspOp(opEnv(
      { operation: 'rename', filePath: libPy, line: 1, character: 5, newName: 'double_it', apply: true },
      libPy,
    ))
    const libAfter = readFileSync(libPy, 'utf8')
    const mainAfter = readFileSync(mainPy, 'utf8')
    check('apply writes both files through the transaction', apply.applied === true && libAfter.includes('def double_it') && mainAfter.includes('import double_it'), `${apply.effect.outcome}: ${apply.result.split('\n')[0]}`)
    check('effect carries the exact changed paths', apply.effect.changedPaths.length === 2 && apply.effect.outcome !== 'failed', JSON.stringify(apply.effect.changedPaths))
    check('post-apply stabilization verdict is honest (never silent)', /post-apply diagnostics/i.test(apply.result), apply.result.split('\n').at(-1))
  }

  section('(5) formatting honesty — the capability-owned refusal or the real format')
  {
    const ruffProbe = probeRuff()
    const out = await runMercuryLspOp(opEnv({ operation: 'formatDocument', filePath: mainPy }, mainPy))
    if (ruffProbe.available) {
      check('ruff formats (preview) through the owner', out.effect.outcome !== 'failed', out.result.split('\n')[0])
      console.log(`  (ruff ${ruffProbe.version} present — formatting owner leg ran live)`)
    } else {
      check(
        'no ruff ⇒ the PRECISE refusal names the checked server + the remedy',
        out.effect.outcome === 'no-change' && out.result.includes('mercury-pyright') && out.result.includes('ruff'),
        out.result.split('\n')[0],
      )
      console.log('  [NOTE — machine] ruff not installed: the live ruff format/organize legs did not run here;')
      console.log('  the refusal contract (the honest arm) is what this machine proves. Install ruff to run the other arm.')
    }
  }

  section('(6) hygiene — status rows + clean shutdown')
  {
    const status = await runMercuryLspOp(opEnv({ operation: 'serverStatus', filePath: mainPy }, mainPy))
    check('serverStatus names mercury-pyright running', status.result.includes('mercury-pyright') && /running/.test(status.result), status.result.split('\n')[0])
  }
} finally {
  unsubscribe()
  await manager.shutdown().catch(() => {})
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
}

const stillRunning = [...manager.getAllServers().values()].filter(s => s.state === 'running')
check('shutdown left no running servers', stillRunning.length === 0, stillRunning.map(s => s.name).join(', '))

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL PYTHON INTEL LIVE CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
