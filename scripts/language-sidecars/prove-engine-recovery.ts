#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-engine-recovery.ts — (verify-wave finding
//  #2): a grammar detonation must not poison LATER parses — the engine
//  refetch must be REAL (require-cache eviction; the vendored loader
//  memoizes its emscripten Module at module scope, so a cached re-require
//  returns the same poisoned heap).
//
//  Uses the REJECTED pack yaml wasm (the live detonator from S2) out of the
//  local fetch-grammars tarball cache. No cache ⇒ loud SKIP with the remedy
//  (never a silent green).
// ============================================================================

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const TARBALL = join(ROOT, 'vendor', 'grammars', 'tarball', 'tree-sitter-wasms-0.1.13.tgz')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(TARBALL)) {
  console.log('  [SKIP] no local tree-sitter-wasms tarball cache — run `bun run scripts/vendor/fetch-grammars.ts` first (the detonator wasm comes from it)')
  console.log('\nengine recovery: SKIPPED (cache absent)')
  process.exit(0)
}

// Extract the REJECTED yaml wasm (the detonator) from the cached tarball.
const extract = mkdtempSync(join(tmpdir(), 'vista-recovery-tar-'))
const tar = spawnSync('tar', ['-xzf', TARBALL, '-C', extract, '--strip-components', '1', 'package/out/tree-sitter-yaml.wasm'], { encoding: 'utf8' })
if (tar.status !== 0 || !existsSync(join(extract, 'out', 'tree-sitter-yaml.wasm'))) {
  console.error(`FAIL: could not extract the detonator wasm: ${tar.stderr}`)
  process.exit(1)
}

// Compose an engine dir: the REAL runtime + python + the detonator.
const engineDir = mkdtempSync(join(tmpdir(), 'vista-recovery-engine-'))
const wasmSrc = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
for (const f of ['tree-sitter.js', 'tree-sitter.wasm', 'tree-sitter-python.wasm']) {
  copyFileSync(join(wasmSrc, f), join(engineDir, f))
}
copyFileSync(join(extract, 'out', 'tree-sitter-yaml.wasm'), join(engineDir, 'tree-sitter-yaml.wasm'))
process.env.MERCURY_TREESITTER_VENDOR_DIR = engineDir

const { loadGrammarEngine, parsePolyglot, _resetGrammarEngineForTesting } = await import(
  '../../src/services/structure/grammarFacility.ts'
)

const yamlLang = { name: 'yaml-detonator', wasm: 'tree-sitter-yaml.wasm', extensions: ['.yaml'] }
const pyLang = { name: 'python', wasm: 'tree-sitter-python.wasm', extensions: ['.py'] }
const PY_GOOD = 'def greet(name):\n    print(name)\n'

_resetGrammarEngineForTesting()
const engine = await loadGrammarEngine()
if (engine.state === 'unavailable') {
  console.error(`FAIL: engine unavailable: ${engine.note}`)
  process.exit(1)
}

// 1. Baseline: python parses clean on the fresh engine.
{
  const p = await parsePolyglot(engine, pyLang, PY_GOOD)
  check('baseline python parses clean', !('state' in p) && p.parseErrors.length === 0)
  if (!('state' in p)) p.tree.delete()
}

// 2. Detonate: the rejected yaml wasm must answer unavailable, never throw.
{
  const p = await parsePolyglot(engine, yamlLang, 'key: value\n')
  check('the detonator answers unavailable BY NAME', 'state' in p && p.note.includes('yaml-detonator'), JSON.stringify(p).slice(0, 140))
}

// 3. RECOVERY on the SAME (poisoned) engine reference — the in-flight-batch
//    shape: parsePolyglot must transparently refetch a fresh heap and parse
//    correctly (pre-fix this misparsed: the observed lua-after-yaml class).
{
  const p = await parsePolyglot(engine, pyLang, PY_GOOD)
  check('python parses CLEAN on the same reference after the detonation', !('state' in p) && p.parseErrors.length === 0, JSON.stringify(p).slice(0, 140))
  if (!('state' in p)) p.tree.delete()
  const broken = await parsePolyglot(engine, pyLang, 'def broken(:\n')
  check('error honesty intact after recovery', !('state' in broken) && broken.parseErrors.length > 0)
  if (!('state' in broken)) broken.tree.delete()
}

// 4. A SECOND detonation attempt still answers unavailable (stable refusal).
{
  const fresh = await loadGrammarEngine()
  if (fresh.state === 'unavailable') {
    check('fresh engine after recovery', false, fresh.note)
  } else {
    const p = await parsePolyglot(fresh, yamlLang, 'a: b\n')
    check('a second detonation still refuses by name', 'state' in p && p.note.includes('yaml-detonator'))
    const py = await parsePolyglot(fresh, pyLang, PY_GOOD)
    check('and python still parses clean after it', !('state' in py) && py.parseErrors.length === 0)
    if (!('state' in py)) py.tree.delete()
  }
}

if (failures > 0) {
  console.error(`\nengine recovery: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nengine recovery: green')
