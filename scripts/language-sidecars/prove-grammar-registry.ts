#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { GRAMMAR_REGISTRY, GRAMMAR_ENGINE_RUNTIME_FILES } = await import('../../src/services/structure/grammarRegistry.ts')
const { languageForFile, languageByName } = await import('../../src/services/structure/grammarFacility.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

{
  const names = GRAMMAR_REGISTRY.map(g => g.name)
  const wasms = GRAMMAR_REGISTRY.map(g => g.wasm)
  check('unique names', new Set(names).size === names.length)
  check('unique wasm files', new Set(wasms).size === wasms.length)
  const allExts = GRAMMAR_REGISTRY.flatMap(g => g.extensions)
  check('every extension lowercase-dotted', allExts.every(e => e.startsWith('.') && e === e.toLowerCase()))
  check('no extension claimed twice', new Set(allExts).size === allExts.length, allExts.join(','))
  const allBases = GRAMMAR_REGISTRY.flatMap(g => (g.basenames ?? []).map(b => b.toLowerCase()))
  check('no basename claimed twice', new Set(allBases).size === allBases.length)
  check('wasm filenames follow tree-sitter-<x>.wasm', wasms.every(w => /^tree-sitter-[a-z0-9_-]+\.wasm$/.test(w)))
}

{
  const wasmDir = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
  const vscodeEntries = GRAMMAR_REGISTRY.filter(g => (g.source ?? 'vscode-pack') === 'vscode-pack')
  if (!existsSync(wasmDir)) {
    check('vscode source package present (bun install)', false, wasmDir)
  } else {
    const missing = vscodeEntries.filter(g => !existsSync(join(wasmDir, g.wasm))).map(g => g.wasm)
    check('vscode package supplies every vscode-pack wasm', missing.length === 0, missing.join(','))
  }
  const packEntries = GRAMMAR_REGISTRY.filter(g => g.source === 'grammar-pack')
  const lockPath = join(ROOT, 'vendor', 'grammars.lock.json')
  check('grammar-pack lock present', existsSync(lockPath))
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { grammars: Array<{ wasm: string; sha256: string; upstream?: { license?: string } }> }
    const lockWasms = new Set(lock.grammars.map(g => g.wasm))
    const noLock = packEntries.filter(g => !lockWasms.has(g.wasm)).map(g => g.wasm)
    check('every grammar-pack registry entry has a lock row', noLock.length === 0, noLock.join(','))
    const registered = new Set(packEntries.map(g => g.wasm))
    const orphanLock = lock.grammars.filter(g => !registered.has(g.wasm)).map(g => g.wasm)
    check('every lock row has a registry entry (two-way)', orphanLock.length === 0, orphanLock.join(','))
    check('every lock row carries an upstream licence', lock.grammars.every(g => !!g.upstream?.license))
  }
  const packDir = join(ROOT, 'vendor', 'grammars', 'extracted')
  if (existsSync(packDir)) {
    const missing = packEntries.filter(g => !existsSync(join(packDir, g.wasm))).map(g => g.wasm)
    check('grammar-pack cache supplies every grammar-pack wasm', missing.length === 0, missing.join(','))
  } else {
    console.log('  [SKIP] vendor/grammars/extracted absent — run scripts/vendor/fetch-grammars.ts (build degrades honestly meanwhile)')
  }
}

{
  const dist = join(ROOT, 'dist', 'vendor', 'treesitter')
  if (!existsSync(join(dist, 'vendor.json'))) {
    console.log('  [SKIP] dist/vendor/treesitter not built — two-way checks run on built trees')
  } else {
    const manifestPath = join(ROOT, 'dist', 'manifest.json')
    const degraded: string[] = existsSync(manifestPath)
      ? ((JSON.parse(readFileSync(manifestPath, 'utf8')) as { degraded?: string[] }).degraded ?? [])
      : []
    const packDegraded = degraded.includes('structure-polyglot-extended')
    const expected = packDegraded
      ? GRAMMAR_REGISTRY.filter(g => (g.source ?? 'vscode-pack') === 'vscode-pack')
      : GRAMMAR_REGISTRY
    const missing = expected.filter(g => !existsSync(join(dist, g.wasm))).map(g => g.wasm)
    check(`dist ships every ${packDegraded ? 'vscode-pack (degraded honest)' : 'registry'} wasm`, missing.length === 0, missing.join(','))
    const registered = new Set(GRAMMAR_REGISTRY.map(g => g.wasm))
    const shipped = readdirSync(dist).filter(f => f.startsWith('tree-sitter-') && f.endsWith('.wasm'))
    const extra = shipped.filter(f => !registered.has(f))
    check('dist ships NO unregistered grammar wasm', extra.length === 0, extra.join(','))
    for (const f of GRAMMAR_ENGINE_RUNTIME_FILES) check(`runtime file ${f} present`, existsSync(join(dist, f)))
    check('LICENSE present', existsSync(join(dist, 'LICENSE')))
    if (!packDegraded) {
      check('pack LICENSE travels with the artifact', existsSync(join(dist, 'LICENSE.grammar-pack')))
      check('per-grammar provenance travels with the artifact', existsSync(join(dist, 'GRAMMAR-NOTICES.json')))
    }
    const pkg = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8')) as { type?: string }
    check('commonjs stamp present', pkg.type === 'commonjs')
    const vendor = JSON.parse(readFileSync(join(dist, 'vendor.json'), 'utf8')) as { grammars?: string[]; version?: string }
    check(
      'vendor.json grammar list EXACTLY equals the shipped expectation (order too)',
      JSON.stringify(vendor.grammars) === JSON.stringify(expected.map(g => g.wasm)),
    )
  }
}

{
  check('.py routes to python', languageForFile('a/b/app.py')?.name === 'python')
  check('extension match is case-insensitive', languageForFile('APP.PY')?.name === 'python')
  check('.ps1 routes to powershell (S1 mapping)', languageForFile('deploy.ps1')?.name === 'powershell')
  check('.ini routes to ini (S1 mapping)', languageForFile('settings.ini')?.name === 'ini')
  check('.regex routes to regex (S1 mapping)', languageForFile('corpus.regex')?.name === 'regex')
  check('unmapped basename stays null (Dockerfile has no grammar yet)', languageForFile('Dockerfile') === null)
  check('languageByName finds every registry row', GRAMMAR_REGISTRY.every(g => languageByName(g.name)?.wasm === g.wasm))
  check('languageByName refuses unknown', languageByName('klingon') === null)
  const facility = readFileSync(join(ROOT, 'src', 'services', 'structure', 'grammarFacility.ts'), 'utf8')
  const baseIdx = facility.indexOf('BASENAME_TO_LANG.get')
  const extIdx = facility.indexOf('EXT_TO_LANG.get')
  check('languageForFile consults basenames BEFORE extensions', baseIdx > 0 && extIdx > 0 && baseIdx < extIdx)
}

{
  const buildTs = readFileSync(join(ROOT, 'build.ts'), 'utf8')
  check(
    'build.ts carries no hand-kept grammar literal (imports the registry)',
    !buildTs.includes("'tree-sitter-python.wasm'") && buildTs.includes('grammarRegistry'),
  )
}

if (failures > 0) {
  console.error(`\ngrammar registry: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\ngrammar registry: green')
