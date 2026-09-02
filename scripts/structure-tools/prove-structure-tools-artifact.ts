#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/prove-structure-tools-artifact.ts — the surfaces exist INSIDE
//  the built artifact (host-side green can be DCE'd out of a build — the
//  banked host-vs-binary law), and the PACKAGED grammar engine actually
//  parses under stock node from the dist layout:
//
//    S. structural: bundle markers for the polyglot lane + its flags;
//    M. manifest: treeSitter vendored, degraded list clean, the vendor dir
//       holds the loader + runtime + every language-table grammar;
//    E. engine: a stock-node child process loads dist/vendor/treesitter
//       from a DISPOSABLE cwd and parses python/go/rust/typescript.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const dist = join(repoRoot, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.log('dist/mercury.mjs missing — building once')
  execFileSync(`${process.env.HOME}/.bun/bin/bun`, ['run', 'build.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 300_000,
  })
}

// ── S. structural markers inside the bundle ─────────────────────────────────
console.log('\nS. polyglot lane exists inside the artifact')
const bundle = readFileSync(dist, 'utf8')
for (const [label, marker] of [
  ['flag MERCURY_STRUCTURE_POLYGLOT read', 'MERCURY_STRUCTURE_POLYGLOT'],
  ['flag MERCURY_TREESITTER_VENDOR_DIR read', 'MERCURY_TREESITTER_VENDOR_DIR'],
  ['metavariable encoder', '__MVM_'],
  ['pattern-lane refusal grammar', 'the pattern does not parse as'],
  ['engine loader entry', 'tree-sitter.js'],
] as const) {
  check(label, bundle.includes(marker), `marker '${marker}' absent — stale dist? (bun run build.ts)`)
}

// ── M. manifest + vendor dir ────────────────────────────────────────────────
console.log('\nM. manifest + vendored engine assets')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'dist', 'manifest.json'), 'utf8')) as {
  treeSitter?: { vendored: boolean; path: string; version?: string }
  degraded: string[]
}
check('manifest.treeSitter.vendored', manifest.treeSitter?.vendored === true, JSON.stringify(manifest.treeSitter))
check('degraded list clean of structure-polyglot', !manifest.degraded.includes('structure-polyglot'))
const vendorDir = join(repoRoot, 'dist', manifest.treeSitter?.path ?? 'vendor/treesitter')
const REQUIRED = [
  'tree-sitter.js',
  'tree-sitter.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'vendor.json',
]
for (const file of REQUIRED) {
  check(`vendored ${file}`, existsSync(join(vendorDir, file)))
}

// ── E. the engine parses under STOCK NODE from a disposable cwd ────────────
console.log('\nE. stock-node parse through the dist assets')
const cwd = mkdtempSync(join(tmpdir(), 'lathe-artifact-'))
const script = `
const path = require('path');
const dir = ${JSON.stringify(vendorDir)};
const TS = require(path.join(dir, 'tree-sitter.js'));
(async () => {
  await TS.Parser.init({ locateFile: f => path.join(dir, f) });
  const parser = new TS.Parser();
  const cases = [
    ['tree-sitter-python.wasm', 'def f(x):\\n    return x\\n', 'module'],
    ['tree-sitter-go.wasm', 'package p\\nfunc F() {}\\n', 'source_file'],
    ['tree-sitter-rust.wasm', 'fn f() -> i32 { 1 }\\n', 'source_file'],
    ['tree-sitter-typescript.wasm', 'const x: number = 1;\\n', 'program'],
  ];
  for (const [wasm, code, rootType] of cases) {
    parser.setLanguage(await TS.Language.load(path.join(dir, wasm)));
    const t = parser.parse(code);
    if (t.rootNode.type !== rootType || t.rootNode.hasError) throw new Error(wasm + ': ' + t.rootNode.type + ' err=' + t.rootNode.hasError);
    console.log('parsed', wasm);
  }
  console.log('ENGINE-OK');
})().catch(e => { console.error(e.message); process.exit(1); });
`
try {
  const out = execFileSync('node', ['-e', script], { cwd, encoding: 'utf8', timeout: 60_000 })
  check('all four mandated grammars parse under stock node', out.includes('ENGINE-OK'), out.trim().slice(-120))
} catch (err) {
  check('all four mandated grammars parse under stock node', false, String(err).slice(0, 200))
}

console.log(failures === 0 ? '\nLATHE ARTIFACT GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
