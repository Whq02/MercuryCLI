#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-loader-channel-quiet.ts — the vendored
//  tree-sitter loader's diagnostics never reach the product's stdout
//  (FC-116). Loading a wasm that is not a grammar made the library dump
//  the module's whole export listing (150+ lines) through console.log
//  before rejecting — interleaved into any machine-readable output the
//  product was emitting. The facility now routes the library channels to
//  the debug log for exactly the awaited loader calls; the honest reject
//  note is unchanged and the dump is kept on the debug channel, not lost.
//
//  §1 the driven load: a not-a-grammar wasm rejects with the honest note
//     and ZERO console/stdout output.
//  §2 a REAL grammar still loads and parses (the routing broke nothing).
//  §3 call-shaped: both awaited loader calls run under the router.
//
//  Run: ~/.bun/bin/bun run scripts/language-sidecars/prove-loader-channel-quiet.ts
// ============================================================================
import { copyFileSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'loader-quiet-')))
copyFileSync(join(SRC, 'tree-sitter.js'), join(DIR, 'tree-sitter.js'))
copyFileSync(join(SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter.wasm'))
// The runtime wasm masquerading as a grammar IS the card's repro.
copyFileSync(join(SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter-notagrammar.wasm'))
copyFileSync(join(SRC, 'tree-sitter-python.wasm'), join(DIR, 'tree-sitter-python.wasm'))
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
  console.log('\nprove-loader-channel-quiet: 1 FAILURE(S)')
  process.exit(1)
}

// Capture EVERY product-visible channel around the load: console (bun's
// console.log does not pass through process.stdout.write) and the raw
// stream writes.
type Captured = { consoleCalls: string[]; stdoutWrites: string[] }
const captureAround = async <T>(fn: () => Promise<T>): Promise<{ result: T; captured: Captured }> => {
  const captured: Captured = { consoleCalls: [], stdoutWrites: [] }
  const orig = { log: console.log, warn: console.warn, error: console.error, write: process.stdout.write }
  console.log = ((...a: unknown[]) => captured.consoleCalls.push(a.map(String).join(' '))) as never
  console.warn = ((...a: unknown[]) => captured.consoleCalls.push(a.map(String).join(' '))) as never
  console.error = ((...a: unknown[]) => captured.consoleCalls.push(a.map(String).join(' '))) as never
  process.stdout.write = ((c: unknown) => {
    captured.stdoutWrites.push(String(c))
    return true
  }) as never
  try {
    const result = await fn()
    return { result, captured }
  } finally {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
    process.stdout.write = orig.write
  }
}

section('§1 A NOT-A-GRAMMAR WASM REJECTS QUIETLY')
{
  const { result, captured } = await captureAround(() =>
    engine.loadLanguage({ name: 'notagrammar', wasm: 'tree-sitter-notagrammar.wasm' } as never),
  )
  const note = (result as { note?: string } | null)?.note ?? ''
  check(
    'the reject is honest and typed (unavailable with a note naming the failure)',
    note.includes('failed to load'),
    note,
  )
  check(
    'ZERO console output during the load (the 150-line symbol dump is gone from the product channel)',
    captured.consoleCalls.length === 0,
    captured.consoleCalls[0]?.slice(0, 80) ?? '',
  )
  check('ZERO raw stdout writes during the load', captured.stdoutWrites.length === 0)
}

section('§2 A REAL GRAMMAR STILL LOADS AND PARSES')
{
  const { result, captured } = await captureAround(() =>
    engine.loadLanguage({ name: 'python', wasm: 'tree-sitter-python.wasm' } as never),
  )
  const loaded = result as { state?: string } | object
  check(
    'python loads (no unavailable state)',
    typeof loaded === 'object' && loaded !== null && (loaded as { state?: string }).state === undefined,
  )
  check('and loads quietly too', captured.consoleCalls.length === 0 && captured.stdoutWrites.length === 0)
  engine.parser.setLanguage(result)
  const tree = engine.parser.parse('print(1)')
  check('and parses', tree !== null && tree.rootNode.type === 'module')
  tree?.delete()
}

section('§3 BOTH LOADER CALLS RUN UNDER THE ROUTER (call-shaped)')
{
  const facility = readFileSync(join(ROOT, 'src', 'services', 'structure', 'grammarFacility.ts'), 'utf-8')
  check(
    'Parser.init is wrapped',
    /withLibraryChannelsRouted\(\(\) =>\s*\n?\s*mod\.Parser\.init\(/.test(facility),
  )
  check(
    'Language.load is wrapped',
    /withLibraryChannelsRouted\(\(\) => mod\.Language\.load\(wasmPath\)\)/.test(facility),
  )
}

console.log(failures === 0 ? '\nprove-loader-channel-quiet: all green' : `\nprove-loader-channel-quiet: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
