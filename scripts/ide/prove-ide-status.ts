#!/usr/bin/env bun
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
console.log(' IDE status surfaces — readiness rows · health fast row')
console.log('============================================================')

const proj = mkdtempSync(path.join(tmpdir(), 'mercury-status-'))
writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname = "status-fixture"\n')
process.chdir(proj)
process.env.MERCURY_PYTHON = SYS_PY
if (existsSync(PYRIGHT_CACHE)) process.env.MERCURY_PYRIGHT_VENDOR_DIR = PYRIGHT_CACHE

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { collectReadiness } = await import('../../src/platform/health/readiness.js')
const proj_ = await import('../../src/integrations/ide/pythonProject.js')
const { probeBuiltinClangd, probeCompileDb } = await import('../../src/integrations/lsp/clangdLane.js')
proj_._resetPythonProjectForTesting()

try {
  section('(1) lane:python — the shared owner truth')
  {
    const rows = collectReadiness({ includeEnv: false }).records
    const py = rows.find(r => r.id === 'lane:python')
    check('row exists and is ready under the healthy pin', py?.state === 'ready', JSON.stringify(py).slice(0, 200) + ' · the lane:python record built in src/platform/health/readiness.ts must read ready when MERCURY_PYTHON points at a working interpreter')
    check('row carries interpreter + pyright + ruff truth', (py?.detail ?? '').includes(SYS_PY) && (py?.detail ?? '').includes('pyright') && (py?.detail ?? '').includes('ruff'), (py?.detail ?? '') + ' · the lane:python detail in src/platform/health/readiness.ts must name the interpreter path, pyright and ruff')
    check('row names its probe source', (py?.source ?? '').includes('boot probes'), 'source: ' + (py?.source ?? '') + ' · the lane:python record in src/platform/health/readiness.ts must carry a source naming boot probes')

    process.env.MERCURY_PYTHON = '/nonexistent/python-pin'
    proj_._resetPythonProjectForTesting()
    const broken = collectReadiness({ includeEnv: false }).records.find(r => r.id === 'lane:python')
    check('a broken pin reads unavailable NAMING the pin', broken?.state === 'unavailable' && (broken?.detail ?? '').includes('MERCURY_PYTHON'), (broken?.detail ?? '') + ' · the lane:python record in src/platform/health/readiness.ts must read unavailable and name MERCURY_PYTHON when the pin is broken')
    process.env.MERCURY_PYTHON = SYS_PY
    proj_._resetPythonProjectForTesting()
  }

  section('(2) lane:cpp — clangd + compile-DB walk truth')
  {
    const rows = collectReadiness({ includeEnv: false }).records
    const cpp = rows.find(r => r.id === 'lane:cpp')
    const clangd = probeBuiltinClangd()
    const db = probeCompileDb()
    check('row exists', cpp !== undefined, 'collectReadiness in src/platform/health/readiness.ts returned no lane:cpp record')
    if (clangd.available) {
      check('row state matches the clangd probe (configured — present, not spawned)', cpp?.state === 'configured' && (cpp?.detail ?? '').includes(clangd.clangdPath ?? ''), (cpp?.detail ?? '') + ' · the lane:cpp record in src/platform/health/readiness.ts must agree with probeBuiltinClangd in src/integrations/lsp/clangdLane.ts')
      check('an absent compile DB carries the cmake remedy', db.compileDb !== undefined || (cpp?.remedy ?? '').includes('compile_commands'), (cpp?.remedy ?? '') + ' · the lane:cpp record in src/platform/health/readiness.ts must carry a remedy naming compile_commands when no compile DB is found')
    } else {
      check('row state matches the clangd probe (unavailable + reason)', cpp?.state === 'unavailable' && (cpp?.detail ?? '').length > 0, (cpp?.detail ?? '') + ' · the lane:cpp record in src/platform/health/readiness.ts must read unavailable with the clangd probe reason when clangd is absent')
    }
  }

  section('(3) engine:ide-plane — the durable-record verdicts')
  {
    const tests = await import('../../src/integrations/ide/pythonTests.js')
    const run = await tests.runPythonTests({ from: proj, framework: 'unittest', selectionLabel: 'all' })
    check('fixture test run recorded (0 tests is a recorded run)', run.state === 'ok', JSON.stringify(run).slice(0, 120) + ' · runPythonTests in src/integrations/ide/pythonTests.ts must record a run for the fixture project')
    const rows = collectReadiness({ includeEnv: false }).records
    const plane = rows.find(r => r.id === 'engine:ide-plane')
    check('plane row reads the latest test record', plane !== undefined && (plane?.detail ?? '').includes(run.state === 'ok' ? run.record.id : 'x'), (plane?.detail ?? 'no engine:ide-plane row') + ' · the engine:ide-plane record in src/platform/health/readiness.ts must read the latest test record id')
  }

  section('(4) health parity — the ide-plane-fast check calls the SAME probes')
  {
    const { codingLoopFastChecks } = await import('../../src/platform/health/sections/coding-loop-fast.ts')
    const planeRow = codingLoopFastChecks().find(row => row.id === 'ide-plane-fast')
    check('health carries the ide-plane-fast check', planeRow?.label === 'IDE plane', 'codingLoopFastChecks in src/platform/health/sections/coding-loop-fast.ts must list ide-plane-fast labelled IDE plane')
    const planeSays = await planeRow?.run()
    const planeWords = `${planeSays?.evidence}\n${planeSays?.detail}`
    const pyProject = await import('../../src/integrations/ide/pythonProject.ts')
    const { probeBuiltinPyright } = await import('../../src/integrations/lsp/pyrightLane.ts')
    const { probeRuff } = await import('../../src/integrations/lsp/ruffLane.ts')
    const clang = await import('../../src/integrations/lsp/clangdLane.ts')
    const { latestTransaction } = await import('../../src/integrations/ide/ideTransaction.ts')
    const { latestRun } = await import('../../src/integrations/ide/pythonTests.ts')
    const py = pyProject.selectPythonInterpreter()
    const pyright = probeBuiltinPyright()
    const ruff = probeRuff()
    const clangd = clang.probeBuiltinClangd()
    const db = clang.probeCompileDb()
    const tx = latestTransaction()
    const lastRun = latestRun()
    const parity: Array<[string, string]> = [
      ['selectPythonInterpreter', py.state === 'ok' ? `python ${py.version} (${py.envKind})` : `python UNAVAILABLE (${py.detail.slice(0, 80)})`],
      ['probeBuiltinPyright', py.state === 'ok' ? `pyright ${pyright.available ? `${pyright.source}${pyright.version ? ` ${pyright.version}` : ''}` : 'ABSENT'}` : 'python UNAVAILABLE'],
      ['probeRuff', py.state === 'ok' ? `ruff ${ruff.available ? (ruff.version ?? 'ok') : 'ABSENT'}` : 'python UNAVAILABLE'],
      ['probeBuiltinClangd', clangd.available ? `clangd ${clangd.clangdPath}` : `clangd ABSENT (${clangd.reason?.slice(0, 60)})`],
      ['probeCompileDb', clangd.available ? `compile DB ${db.compileDb ?? 'ABSENT'}` : 'clangd ABSENT'],
      ['latestTransaction', `latest transaction ${tx ? `${tx.id} [${tx.verdict}]` : '—'}`],
      ['latestRun', `latest test run ${lastRun ? `${lastRun.id} (${lastRun.counts.failed === 0 ? 'green' : `${lastRun.counts.failed} failing`})` : '—'}`],
    ]
    for (const [probe, said] of parity) {
      check(`health row consumes ${probe} (probe parity)`, planeWords.includes(said), `wanted: ${said} · row: ${planeWords.slice(0, 400)} · idePlaneFastCheck in src/platform/health/sections/coding-loop-fast.ts must print what ${probe} returns`)
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
