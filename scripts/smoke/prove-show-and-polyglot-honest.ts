#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

section('§1 FC-043 — the detection module')
{
  const { detectImageProtocol, _resetImageProtocolForTesting } = await import(
    '../../src/screen/image-display/imageDisplay.ts'
  )
  _resetImageProtocolForTesting()
  if (process.stdout.isTTY) {
    check('harness note: stdout unexpectedly a TTY — module leg skipped', true)
  } else {
    check('a non-TTY stdout answers the plain link tier', detectImageProtocol() === 'link', detectImageProtocol(), 'detectImageProtocol in src/screen/image-display/imageDisplay.ts must return link when stdout is not a TTY; also check that MERCURY_IMAGE_PROTOCOL is not set in the shell running this proof')
  }
}

if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — build first')
  process.exit(1)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

section('§2 FC-043 — the redirected show')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'show-honest-')))
  const img = join(home, 'probe.png')
  writeFileSync(img, PNG)
  const run = spawnSync('node', [DIST, 'image', img], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const escapes = (run.stdout ?? '').split('\x1b').length - 1
  check('the redirected show exits 0', run.status === 0, `status=${run.status}`, 'mercury image on a PNG failed when redirected; read the image verb in src/boot/main/verbActions.ts and renderImageForTerminal in src/screen/image-display/imageDisplay.ts, and rebuild dist with bun run build.ts if dist is stale')
  check('and stdout carries ZERO escape bytes (FC-043)', escapes === 0, `escapes=${escapes}`, 'a redirected mercury image must print the plain link tier with no terminal escapes; fix the protocol choice in detectImageProtocol and renderImageForTerminal in src/screen/image-display/imageDisplay.ts')
  check('the plain pointer names the file', (run.stdout ?? '').includes('probe.png'), JSON.stringify((run.stdout ?? '').slice(0, 80)), 'the link tier payload must carry the image file name; fix renderImageForTerminal in src/screen/image-display/imageDisplay.ts')
  rmSync(home, { recursive: true, force: true })
}

section('§3 FC-049 — the measured polyglot count')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'polyglot-honest-')))
  const engineDir = realpathSync(mkdtempSync(join(tmpdir(), 'polyglot-engine-')))
  const src = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')
  copyFileSync(join(src, 'tree-sitter.js'), join(engineDir, 'tree-sitter.js'))
  copyFileSync(join(src, 'tree-sitter.wasm'), join(engineDir, 'tree-sitter.wasm'))
  const run = spawnSync('node', [DIST, 'health', '--json', '--only', 'anvil-workbench-fast'], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_TREESITTER_VENDOR_DIR: engineDir },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const record = run.stdout ?? ''
  check('the row reports a measured shortfall, never the constant', /0 of \d+ languages present/.test(record), record.match(/polyglot[^\\n"]{0,90}/)?.[0], 'the anvil-workbench-fast health row must print the measured count of present tree-sitter languages; fix the polyglot patterns line in src/platform/health/sections/coding-loop-fast.ts, and check that node_modules/@vscode/tree-sitter-wasm/wasm holds tree-sitter.js and tree-sitter.wasm')
  rmSync(home, { recursive: true, force: true })
  rmSync(engineDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-show-and-polyglot-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-show-and-polyglot-honest: all green')
