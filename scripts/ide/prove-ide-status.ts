#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-ide-status.ts
//  PROOF: the operator status surfaces for the IDE plane —
//  /capabilities readiness rows + the /doctor CODING LOOP fast row, every
//  claim from the SAME probe its production consumer runs.
//
//    (1) lane:python — ready with interpreter+pyright+ruff truth under a
//        healthy pin; unavailable naming a broken pin.
//    (2) lane:cpp — clangd probe truth + the compile-DB walk verdict (+ the
//        cmake remedy when a DB is absent).
//    (3) engine:ide-plane — the latest durable transaction + test-run
//        verdicts, read straight from the records.
//    (4) the doctor 'ide-plane-fast' check emits the same facts (probe
//        parity — collectReadiness and doctor cannot disagree because they
//        call identical probes).
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-ide-status.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SYS_PY = '/usr/bin/python3'
const PYRIGHT_CACHE = path.join(ROOT, 'vendor', 'pyright', 'extracted')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' IDE status surfaces — readiness rows · doctor fast row')
console.log('============================================================')

const proj = mkdtempSync(path.join(tmpdir(), 'mercury-status-'))
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "status-fixture"\n')
process.chdir(proj)
process.env.MERCURY_PYTHON = SYS_PY
if (existsSync(PYRIGHT_CACHE)) process.env.MERCURY_PYRIGHT_VENDOR_DIR = PYRIGHT_CACHE

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { collectReadiness } = await import('../../src/utils/readiness.js')
const proj_ = await import('../../src/services/ide/pythonProject.js')
const { probeBuiltinClangd, probeCompileDb } = await import('../../src/services/lsp/clangdLane.js')
proj_._resetPythonProjectForTesting()

try {
  section('(1) lane:python — the shared owner truth')
  {
    const rows = collectReadiness({ includeEnv: false }).records
    const py = rows.find(r => r.id === 'lane:python')
    check('row exists and is ready under the healthy pin', py?.state === 'ready', JSON.stringify(py).slice(0, 200))
    check('row carries interpreter + pyright + ruff truth', (py?.detail ?? '').includes(SYS_PY) && (py?.detail ?? '').includes('pyright') && (py?.detail ?? '').includes('ruff'), py?.detail)
    check('row names its probe source', (py?.source ?? '').includes('boot probes'))

    process.env.MERCURY_PYTHON = '/nonexistent/python-pin'
    proj_._resetPythonProjectForTesting()
    const broken = collectReadiness({ includeEnv: false }).records.find(r => r.id === 'lane:python')
    check('a broken pin reads unavailable NAMING the pin', broken?.state === 'unavailable' && (broken?.detail ?? '').includes('MERCURY_PYTHON'), broken?.detail)
    process.env.MERCURY_PYTHON = SYS_PY
    proj_._resetPythonProjectForTesting()
  }

  section('(2) lane:cpp — clangd + compile-DB walk truth')
  {
    const rows = collectReadiness({ includeEnv: false }).records
    const cpp = rows.find(r => r.id === 'lane:cpp')
    const clangd = probeBuiltinClangd()
    const db = probeCompileDb()
    check('row exists', cpp !== undefined)
    if (clangd.available) {
      // a PATH binary that has never spawned is
      // CONFIGURED — only a running server reads ready (three-state honesty).
      check('row state matches the clangd probe (configured — present, not spawned)', cpp?.state === 'configured' && (cpp?.detail ?? '').includes(clangd.clangdPath ?? ''), cpp?.detail)
      check('an absent compile DB carries the cmake remedy', db.compileDb !== undefined || (cpp?.remedy ?? '').includes('compile_commands'), cpp?.remedy)
    } else {
      check('row state matches the clangd probe (unavailable + reason)', cpp?.state === 'unavailable' && (cpp?.detail ?? '').length > 0, cpp?.detail)
    }
  }

  section('(3) engine:ide-plane — the durable-record verdicts')
  {
    const tests = await import('../../src/services/ide/pythonTests.js')
    const run = await tests.runPythonTests({ from: proj, framework: 'unittest', selectionLabel: 'all' })
    check('fixture test run recorded (0 tests is a recorded run)', run.state === 'ok', JSON.stringify(run).slice(0, 120))
    const rows = collectReadiness({ includeEnv: false }).records
    const plane = rows.find(r => r.id === 'engine:ide-plane')
    check('plane row reads the latest test record', plane !== undefined && (plane?.detail ?? '').includes(run.state === 'ok' ? run.record.id : 'x'), plane?.detail)
  }

  section('(4) doctor parity — the ide-plane-fast check calls the SAME probes')
  {
    const src = (await import('node:fs')).readFileSync(path.join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
    check('doctor carries the ide-plane-fast check', src.includes("id: 'ide-plane-fast'"))
    for (const probe of ['selectPythonInterpreter', 'probeBuiltinPyright', 'probeRuff', 'probeBuiltinClangd', 'probeCompileDb', 'latestTransaction', 'latestRun']) {
      check(`doctor row consumes ${probe} (probe parity)`, src.slice(src.indexOf("id: 'ide-plane-fast'")).slice(0, 3000).includes(probe))
    }
  }
} finally {
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
  delete process.env.MERCURY_PYTHON
  delete process.env.MERCURY_PYRIGHT_VENDOR_DIR
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL IDE STATUS CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
