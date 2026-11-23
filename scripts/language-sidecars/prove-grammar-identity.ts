#!/usr/bin/env bun
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'grammar-id-')))
copyFileSync(join(SRC, 'tree-sitter.js'), join(DIR, 'tree-sitter.js'))
copyFileSync(join(SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter.wasm'))
copyFileSync(join(SRC, 'tree-sitter-python.wasm'), join(DIR, 'tree-sitter-bash.wasm'))
copyFileSync(join(SRC, 'tree-sitter-c-sharp.wasm'), join(DIR, 'tree-sitter-c-sharp.wasm'))
copyFileSync(join(SRC, 'tree-sitter-typescript.wasm'), join(DIR, 'tree-sitter-typescript.wasm'))
copyFileSync(join(SRC, 'tree-sitter-python.wasm'), join(DIR, 'tree-sitter-serpent.wasm'))
copyFileSync(join(SRC, 'tree-sitter-python.wasm'), join(DIR, 'tree-sitter-adder.wasm'))
copyFileSync(join(SRC, 'tree-sitter-typescript.wasm'), join(DIR, 'tree-sitter-quiet.wasm'))
process.env.MERCURY_TREESITTER_VENDOR_DIR = DIR
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', fixHint = ''): void => {
  const shown = cond || !fixHint ? detail : detail ? `${detail} — ${fixHint}` : fixHint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { loadGrammarEngine } = await import('../../src/platform/grammars/grammarFacility.js')
const engine = await loadGrammarEngine()
if (engine.state !== 'ok') {
  console.log(`  [FAIL] engine unavailable: ${engine.note} — loadGrammarEngine in src/platform/grammars/grammarFacility.ts must load tree-sitter.js and tree-sitter.wasm from MERCURY_TREESITTER_VENDOR_DIR, which this script points at a copy of node_modules/@vscode/tree-sitter-wasm/wasm`)
  console.log('\nprove-grammar-identity: 1 FAILURE(S)')
  process.exit(1)
}
const noteOf = (r: unknown): string => (r as { note?: string } | null)?.note ?? ''
const isUnavailable = (r: unknown): boolean =>
  typeof r === 'object' && r !== null && (r as { state?: string }).state === 'unavailable'

section('§1 THE IMPOSTOR IS REJECTED, NAMED')
{
  const r = await engine.loadLanguage({ name: 'bash', wasm: 'tree-sitter-bash.wasm' } as never)
  check('a python wasm at the bash filename does NOT load as bash', isUnavailable(r), noteOf(r) || 'loaded', 'loadLanguage in src/platform/grammars/grammarFacility.ts must compare the grammar name the wasm declares with the row name and answer unavailable on a mismatch')
  check(
    'the reject names the expected grammar and the declared one',
    noteOf(r).includes("'bash'") && noteOf(r).includes("'python'"),
    noteOf(r),
    'the rejected note built in loadLanguage (src/platform/grammars/grammarFacility.ts) must quote the row name and the declared name, each in single quotes',
  )
}

section('§2 THE REAL GRAMMAR STILL LOADS (SEPARATOR-FOLDED)')
{
  const r = await engine.loadLanguage({ name: 'c-sharp', wasm: 'tree-sitter-c-sharp.wasm' } as never)
  check(
    "c-sharp loads although its grammar declares c_sharp (folded identity)",
    !isUnavailable(r),
    noteOf(r),
    'the identity comparison in loadLanguage (src/platform/grammars/grammarFacility.ts) must fold separators (fold) on both names so c-sharp matches c_sharp',
  )
}

section('§3 A PRE-ABI-15 GRAMMAR IS NEVER FALSELY REJECTED')
{
  const r = await engine.loadLanguage({ name: 'typescript', wasm: 'tree-sitter-typescript.wasm' } as never)
  check('typescript (declares no name) still loads', !isUnavailable(r), noteOf(r), 'loadLanguage in src/platform/grammars/grammarFacility.ts must skip the identity check when the wasm declares no name')
}

section('§4 A ROW MAY NAME THE GRAMMAR ITS WASM DECLARES')
{
  const named = await engine.loadLanguage({ name: 'serpent', wasm: 'tree-sitter-serpent.wasm', declares: 'python' } as never)
  check('a row called serpent whose wasm declares python loads when the row says so', !isUnavailable(named), noteOf(named), 'loadLanguage in src/platform/grammars/grammarFacility.ts must compare the declared name with the declares field of the row when the row has one')
  const wrong = await engine.loadLanguage({ name: 'adder', wasm: 'tree-sitter-adder.wasm', declares: 'ruby' } as never)
  check('a row that names another grammar than its wasm declares is still rejected', isUnavailable(wrong), noteOf(wrong) || 'loaded', 'loadLanguage in src/platform/grammars/grammarFacility.ts must reject a row whose declares field differs from what the wasm declares')
  check(
    'the reject names the row and the grammar the wasm declares',
    noteOf(wrong).includes("'adder'") && noteOf(wrong).includes("'python'"),
    noteOf(wrong),
    'the rejected note built in loadLanguage (src/platform/grammars/grammarFacility.ts) must quote the row name and the grammar the wasm declares',
  )
  const silent = await engine.loadLanguage({ name: 'quiet', wasm: 'tree-sitter-quiet.wasm', declares: 'anything' } as never)
  check('a wasm that declares no name still loads under a row that names one', !isUnavailable(silent), noteOf(silent), 'loadLanguage in src/platform/grammars/grammarFacility.ts must skip the identity check when the wasm declares no name, even if the row sets declares')
}

console.log(failures === 0 ? '\nprove-grammar-identity: all green' : `\nprove-grammar-identity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
