#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-pyright-lane.ts
//  PROOF (structural, no live server): the Python language lanes (ide
// — gating polarity, probe honesty, the live python-section
//  configuration resolver, the ruff version floor, and the deliberate
//  .py multi-provider merge order.
//
//  The LIVE journey (real vendored pyright over a fixture project) is
//  prove-python-intel.ts; the artifact/manifest truth is
//  prove-pyright-vendor.ts.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-pyright-lane.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
// The DIST vendor, not the build's local extraction cache (
// round-5: `vendor/` is untracked build residue — absent from every fresh
// checkout, so the pyright lane never registered on CI; dist/vendor ships
// the identical layout and Phase-0 guarantees it wherever the gate runs).
const CACHE = join(ROOT, 'dist', 'vendor', 'pyright')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const saved = { ...process.env }
function restore(...keys: string[]): void {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

const pyright = await import('../../src/services/lsp/pyrightLane.js')
const ruff = await import('../../src/services/lsp/ruffLane.js')
const { getMercuryLspServerSources } = await import('../../src/services/lsp/builtinServers.js')

console.log('============================================================')
console.log(' python lanes — gating · probes · config resolver · merge order')
console.log('============================================================')

section('(1) gating polarity')
{
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_LSP_PYTHON
  process.env.MERCURY_PYRIGHT_VENDOR_DIR = CACHE
  pyright._resetPyrightProbeCacheForTesting()
  const on = pyright.builtinPyrightServer()
  check('bridge on + lane unset ⇒ mercury-pyright registers (cache present)', existsSync(CACHE) ? 'mercury-pyright' in on : Object.keys(on).length === 0)

  process.env.MERCURY_LSP_PYTHON = '0'
  check('MERCURY_LSP_PYTHON=0 ⇒ pyright lane gone', Object.keys(pyright.builtinPyrightServer()).length === 0)
  check('MERCURY_LSP_PYTHON=0 ⇒ ruff lane gone', Object.keys(ruff.builtinRuffServer()).length === 0)
  delete process.env.MERCURY_LSP_PYTHON

  process.env.MERCURY_LSP = '0'
  check('MERCURY_LSP=0 ⇒ pyright lane gone (master gate)', Object.keys(pyright.builtinPyrightServer()).length === 0)
  delete process.env.MERCURY_LSP
}

section('(2) pyright probe honesty')
if (existsSync(CACHE)) {
  process.env.MERCURY_PYRIGHT_VENDOR_DIR = CACHE
  pyright._resetPyrightProbeCacheForTesting()
  const bundled = pyright.probeBuiltinPyright()
  check('cache tree probes as BUNDLED with the pinned version', bundled.available && bundled.source === 'bundled' && bundled.version === '1.1.413', JSON.stringify(bundled))

  const empty = mkdtempSync(join(tmpdir(), 'no-pyright-'))
  try {
    // an explicit pin at a dir WITHOUT the server
    // entry refuses BY NAME — never a silent PATH fallback (pin honesty).
    process.env.MERCURY_PYRIGHT_VENDOR_DIR = empty
    pyright._resetPyrightProbeCacheForTesting()
    const broken = pyright.probeBuiltinPyright()
    check(
      'a BROKEN pin refuses by name (no silent fallback — S8 pin honesty)',
      !broken.available && (broken.reason ?? '').includes('MERCURY_PYRIGHT_VENDOR_DIR'),
      JSON.stringify(broken),
    )
    // UNPINNED with no bundle-sibling vendor tree: PATH fallback or honest
    // unavailable with the remedy (the original law, now pin-free).
    delete process.env.MERCURY_PYRIGHT_VENDOR_DIR
    pyright._resetPyrightProbeCacheForTesting()
    const fallback = pyright.probeBuiltinPyright()
    check(
      'unpinned + no vendor tree ⇒ PATH fallback or honest unavailable with remedy',
      (fallback.available && (fallback.source === 'path' || fallback.source === 'project-local')) ||
        (!fallback.available && (fallback.reason ?? '').includes('fetch-pyright')),
      JSON.stringify(fallback),
    )
  } finally {
    rmSync(empty, { recursive: true, force: true })
    restore('MERCURY_PYRIGHT_VENDOR_DIR')
    pyright._resetPyrightProbeCacheForTesting()
  }
} else {
  console.log('  [SKIP — LOUD] vendor/pyright/extracted absent — run: bun run scripts/vendor/fetch-pyright.ts')
  failures++
}

section('(3) the LIVE python-section configuration resolver')
{
  process.env.MERCURY_PYTHON = '/usr/bin/python3'
  const { _resetPythonProjectForTesting } = await import('../../src/services/ide/pythonProject.js')
  _resetPythonProjectForTesting()
  const python = pyright.pyrightWorkspaceConfiguration('python') as { pythonPath?: string }
  check('python section answers the SHARED selected interpreter', python?.pythonPath === '/usr/bin/python3', JSON.stringify(python))
  check('other sections defer (null) to project config files', pyright.pyrightWorkspaceConfiguration('python.analysis') === null)
  restore('MERCURY_PYTHON')
  _resetPythonProjectForTesting()
}

section('(4) ruff probe honesty + version floor (PATH-controlled shims)')
{
  const shims = mkdtempSync(join(tmpdir(), 'ruff-shims-'))
  const mkShim = (version: string): void => {
    const p = join(shims, 'ruff')
    writeFileSync(p, `#!/bin/sh\necho "ruff ${version}"\n`)
    chmodSync(p, 0o755)
  }
  const savedPath = process.env.PATH
  try {
    process.env.PATH = shims
    ruff._resetRuffProbeCacheForTesting()
    const absent = ruff.probeRuff()
    check('no ruff ⇒ honest unavailable naming the install remedy', !absent.available && (absent.reason ?? '').includes('install'), JSON.stringify(absent))

    mkShim('0.4.0')
    ruff._resetRuffProbeCacheForTesting()
    const old = ruff.probeRuff()
    check('pre-server ruff (0.4.0) ⇒ refused with the version floor', !old.available && (old.reason ?? '').includes('0.5.3'), JSON.stringify(old))

    mkShim('0.8.1')
    ruff._resetRuffProbeCacheForTesting()
    const good = ruff.probeRuff()
    check('modern ruff (0.8.1) ⇒ available with version', good.available && good.version === '0.8.1', JSON.stringify(good))

    const cfg = ruff.builtinRuffServer()
    const row = cfg['mercury-ruff']
    check('ruff lane config: `ruff server` claiming .py', row !== undefined && row.args?.join(' ') === 'server' && '.py' in row.extensionToLanguage, JSON.stringify(row ?? null).slice(0, 140))
  } finally {
    process.env.PATH = savedPath
    ruff._resetRuffProbeCacheForTesting()
    rmSync(shims, { recursive: true, force: true })
  }
}

section('(5) the deliberate .py multi-provider merge order')
{
  const shims = mkdtempSync(join(tmpdir(), 'ruff-order-'))
  const p = join(shims, 'ruff')
  writeFileSync(p, '#!/bin/sh\necho "ruff 0.8.1"\n')
  chmodSync(p, 0o755)
  const savedPath = process.env.PATH
  try {
    process.env.PATH = `${shims}:${savedPath}`
    process.env.MERCURY_PYRIGHT_VENDOR_DIR = CACHE
    pyright._resetPyrightProbeCacheForTesting()
    ruff._resetRuffProbeCacheForTesting()
    const sources = getMercuryLspServerSources()
    const names = Object.keys(sources.builtin)
    const iPyright = names.indexOf('mercury-pyright')
    const iRuff = names.indexOf('mercury-ruff')
    check('both python lanes register', iPyright !== -1 && iRuff !== -1, names.join(', '))
    check('pyright registers BEFORE ruff (semantic ownership of .py)', iPyright !== -1 && iRuff !== -1 && iPyright < iRuff)
  } finally {
    process.env.PATH = savedPath
    restore('MERCURY_PYRIGHT_VENDOR_DIR')
    pyright._resetPyrightProbeCacheForTesting()
    ruff._resetRuffProbeCacheForTesting()
    rmSync(shims, { recursive: true, force: true })
  }
}

section('(6) registry rows')
{
  const registry = readFileSync(join(ROOT, 'src', 'substrate', 'flagRegistry.ts'), 'utf8')
  check('MERCURY_LSP_PYTHON registered', registry.includes("env: 'MERCURY_LSP_PYTHON'"))
  check('MERCURY_PYRIGHT_VENDOR_DIR registered', registry.includes("env: 'MERCURY_PYRIGHT_VENDOR_DIR'"))
  check('the lane flag keeps its legacy alias', registry.includes('MERCURY_LSP_PYTHON'))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL PYRIGHT/RUFF LANE CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
