#!/usr/bin/env bun
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'loader-quiet-')))
copyFileSync(join(SRC, 'tree-sitter.js'), join(DIR, 'tree-sitter.js'))
copyFileSync(join(SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter.wasm'))
copyFileSync(join(SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter-notagrammar.wasm'))
copyFileSync(join(SRC, 'tree-sitter-python.wasm'), join(DIR, 'tree-sitter-python.wasm'))
process.env.MERCURY_TREESITTER_VENDOR_DIR = DIR
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  const shown = cond || !hint ? detail : detail ? detail + ' | ' + hint : hint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { loadGrammarEngine } = await import('../../src/platform/grammars/grammarFacility.js')
const engine = await loadGrammarEngine()
if (engine.state !== 'ok') {
  console.log(`  [FAIL] engine unavailable: ${engine.note} | the test copies tree-sitter.js and tree-sitter.wasm from node_modules/@vscode/tree-sitter-wasm/wasm into a temp dir; check they exist (bun run setup) and look at loadGrammarEngine in src/platform/grammars/grammarFacility.ts`)
  console.log('\nprove-loader-channel-quiet: 1 FAILURE(S)')
  process.exit(1)
}

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
    'in src/platform/grammars/grammarFacility.ts the loadLanguage catch must return a note that starts with grammar name then failed to load'
  )
  check(
    'ZERO console output during the load (the 150-line symbol dump is gone from the product channel)',
    captured.consoleCalls.length === 0,
    captured.consoleCalls[0]?.slice(0, 80) ?? '',
    'loadLanguage in src/platform/grammars/grammarFacility.ts must run mod.Language.load inside withLibraryChannelsRouted so console.log/warn/error go to logForDebugging',
  )
  check(
    'ZERO raw stdout writes during the load',
    captured.stdoutWrites.length === 0,
    '',
    'something wrote straight to process.stdout during loadLanguage in src/platform/grammars/grammarFacility.ts; withLibraryChannelsRouted only reroutes console.log/warn/error, not process.stdout.write',
  )
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
    '',
    'loadLanguage in src/platform/grammars/grammarFacility.ts returned an unavailable note for tree-sitter-python.wasm; check the wasm copied from node_modules/@vscode/tree-sitter-wasm/wasm and its declared name',
  )
  check(
    'and loads quietly too',
    captured.consoleCalls.length === 0 && captured.stdoutWrites.length === 0,
    '',
    'loadLanguage in src/platform/grammars/grammarFacility.ts printed to console or stdout while loading a real grammar; keep Language.load inside withLibraryChannelsRouted',
  )
  engine.parser.setLanguage(result)
  const tree = engine.parser.parse('print(1)')
  check(
    'and parses',
    tree !== null && tree.rootNode.type === 'module',
    '',
    'engine.parser.parse of print(1) with the python grammar did not give a module root; the language that loadLanguage returned in src/platform/grammars/grammarFacility.ts is not the python grammar',
  )
  tree?.delete()
}


console.log(failures === 0 ? '\nprove-loader-channel-quiet: all green' : `\nprove-loader-channel-quiet: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
