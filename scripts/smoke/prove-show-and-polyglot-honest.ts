#!/usr/bin/env bun
// prove-show-and-polyglot-honest — two reporting defects (field cards
// FC-043 · FC-049).
//
// FC-043: `mercury show <img> > file` wrote raw truecolor escapes into the
//   file and ignored NO_COLOR — every other surface falls back to plain.
//   A redirected stdout (or NO_COLOR) now takes the LINK tier; an explicit
//   protocol pin still wins.
// FC-049: doctor's polyglot row printed the registry CONSTANT — an engine
//   dir with zero grammar wasms still read "23 languages". The row now
//   counts the wasms present and names a shortfall.
//
//   §1 FC-043 module: detection answers link on a non-TTY stdout / NO_COLOR.
//   §2 FC-043 artifact: a redirected show carries ZERO escape bytes.
//   §3 FC-049 artifact: a grammar-less override dir reads 0-of-N, never N.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

section('§1 FC-043 — the detection module')
{
  const { detectImageProtocol, _resetImageProtocolForTesting } = await import(
    '../../src/services/visual/imageDisplay.ts'
  )
  _resetImageProtocolForTesting()
  // Under bun the prover's stdout is a pipe — exactly the redirected shape.
  if (process.stdout.isTTY) {
    check('harness note: stdout unexpectedly a TTY — module leg skipped', true)
  } else {
    check('a non-TTY stdout answers the plain link tier', detectImageProtocol() === 'link', detectImageProtocol())
  }
}

if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — build first')
  process.exit(1)
}

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

section('§2 FC-043 — the redirected show')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'show-honest-')))
  const img = join(home, 'probe.png')
  writeFileSync(img, PNG)
  const run = spawnSync('node', [DIST, 'show', img], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const escapes = (run.stdout ?? '').split('\x1b').length - 1
  check('the redirected show exits 0', run.status === 0, `status=${run.status}`)
  check('and stdout carries ZERO escape bytes (FC-043)', escapes === 0, `escapes=${escapes}`)
  check('the plain pointer names the file', (run.stdout ?? '').includes('probe.png'), JSON.stringify((run.stdout ?? '').slice(0, 80)))
  rmSync(home, { recursive: true, force: true })
}

section('§3 FC-049 — the measured polyglot count')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'polyglot-honest-')))
  const engineDir = realpathSync(mkdtempSync(join(tmpdir(), 'polyglot-engine-')))
  // Engine runtime only — ZERO grammar wasms.
  const src = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
  copyFileSync(join(src, 'tree-sitter.js'), join(engineDir, 'tree-sitter.js'))
  copyFileSync(join(src, 'tree-sitter.wasm'), join(engineDir, 'tree-sitter.wasm'))
  const run = spawnSync('node', [DIST, 'health', '--json', '--only', 'anvil-workbench-fast'], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_TREESITTER_VENDOR_DIR: engineDir },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const record = run.stdout ?? ''
  check('the row reports a measured shortfall, never the constant', /0 of \d+ languages present/.test(record), record.match(/polyglot[^\\n"]{0,90}/)?.[0])
  rmSync(home, { recursive: true, force: true })
  rmSync(engineDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-show-and-polyglot-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-show-and-polyglot-honest: all green')
