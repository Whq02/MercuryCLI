#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-grammar-identity.ts — a loaded grammar's
//  self-declared name must match the registry row (FC-117). Any wasm
//  parked at the expected filename used to be parsed and LABELLED as the
//  registry's language — a python grammar renamed tree-sitter-bash.wasm
//  answered bash queries with python trees and nobody said a word. The
//  ABI-15 pack declares names; pre-ABI-15 grammars declare null and are
//  recorded as unverifiable on the debug channel, never falsely rejected.
//
//  §1 an impostor wasm at a grammar's filename is REJECTED, naming both
//     the expected and the declared grammar.
//  §2 the real grammar still loads (folded: c_sharp matches c-sharp).
//  §3 a pre-ABI-15 grammar (declares null) still loads — no false reject.
//
//  Run: ~/.bun/bin/bun run scripts/language-sidecars/prove-grammar-identity.ts
// ============================================================================
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'grammar-id-')))
copyFileSync(join(SRC, 'tree-sitter.js'), join(DIR, 'tree-sitter.js'))
copyFileSync(join(SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter.wasm'))
// The impostor: python parked at bash's filename (the card's repro shape).
copyFileSync(join(SRC, 'tree-sitter-python.wasm'), join(DIR, 'tree-sitter-bash.wasm'))
// The honest neighbours.
copyFileSync(join(SRC, 'tree-sitter-c-sharp.wasm'), join(DIR, 'tree-sitter-c-sharp.wasm'))
copyFileSync(join(SRC, 'tree-sitter-typescript.wasm'), join(DIR, 'tree-sitter-typescript.wasm'))
process.env.MERCURY_TREESITTER_VENDOR_DIR = DIR
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { loadGrammarEngine } = await import('../../src/services/structure/grammarFacility.js')
const engine = await loadGrammarEngine()
if (engine.state !== 'ok') {
  console.log(`  [FAIL] engine unavailable: ${engine.note}`)
  console.log('\nprove-grammar-identity: 1 FAILURE(S)')
  process.exit(1)
}
const noteOf = (r: unknown): string => (r as { note?: string } | null)?.note ?? ''
const isUnavailable = (r: unknown): boolean =>
  typeof r === 'object' && r !== null && (r as { state?: string }).state === 'unavailable'

section('§1 THE IMPOSTOR IS REJECTED, NAMED')
{
  const r = await engine.loadLanguage({ name: 'bash', wasm: 'tree-sitter-bash.wasm' } as never)
  check('a python wasm at the bash filename does NOT load as bash', isUnavailable(r), noteOf(r) || 'loaded')
  check(
    'the reject names the expected grammar and the declared one',
    noteOf(r).includes("'bash'") && noteOf(r).includes("'python'"),
    noteOf(r),
  )
}

section('§2 THE REAL GRAMMAR STILL LOADS (SEPARATOR-FOLDED)')
{
  const r = await engine.loadLanguage({ name: 'c-sharp', wasm: 'tree-sitter-c-sharp.wasm' } as never)
  check(
    "c-sharp loads although its grammar declares c_sharp (folded identity)",
    !isUnavailable(r),
    noteOf(r),
  )
}

section('§3 A PRE-ABI-15 GRAMMAR IS NEVER FALSELY REJECTED')
{
  const r = await engine.loadLanguage({ name: 'typescript', wasm: 'tree-sitter-typescript.wasm' } as never)
  check('typescript (declares no name) still loads', !isUnavailable(r), noteOf(r))
}

console.log(failures === 0 ? '\nprove-grammar-identity: all green' : `\nprove-grammar-identity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
