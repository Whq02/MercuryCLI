#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const lib = readFileSync(join(ROOT, 'native/desktop/src/lib.rs'), 'utf8')
const windows = readFileSync(join(ROOT, 'native/desktop/src/win.rs'), 'utf8')
const compiler = Bun.which('rustc')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const capture = windows.slice(windows.indexOf('pub fn capture('), windows.indexOf('fn process_image('))
const blit = capture.indexOf('let blit = BitBlt(')
const restored = capture.indexOf('SelectObject(memory, previous);')
const read = capture.indexOf('let lines = GetDIBits(')
check('the Windows capture deselects its bitmap after blitting and before reading', blit >= 0 && restored >= 0 && read >= 0 && restored > blit && read > restored)
check('the Windows capture refuses an incomplete row count', /if lines != height\s*\{/.test(capture))

if (compiler === null) {
  console.log('Native input recording tests not run: rustc is absent; the desktop pack build requires the same toolchain.')
  process.exit(failures === 0 ? 0 : 1)
}
const scratch = mkdtempSync(join(tmpdir(), 'desktop-native-input-'))
try {
  const span = (start: string, end: string): string => {
    const first = lib.indexOf(start)
    const last = lib.indexOf(end, first + start.length)
    if (first < 0 || last <= first) throw new Error(`native input source boundary missing: ${start} / ${end}`)
    return lib.slice(first, last).replaceAll('#[napi]\n', '').replaceAll('#[napi(object)]\n', '')
  }
  const body = [
    span('pub const DRAG_STEPS', '#[napi(object)]'),
    span('pub struct HeldAnswer', 'fn reason('),
    span('pub fn click(', 'pub struct DragTask'),
    span('pub struct DragTask', '#[napi(ts_return_type = "Promise<void>")]\npub fn drag'),
    span('fn chord_of(', 'pub struct TypeTask'),
    lib.slice(lib.indexOf('fn held_answer(')).replaceAll('#[napi]\n', ''),
  ].join('\n')
  const source = join(scratch, 'input.rs')
  const binary = join(scratch, process.platform === 'win32' ? 'input.exe' : 'input')
  writeFileSync(source, `${readFileSync(join(import.meta.dir, 'nativeInputFixture.rs'), 'utf8')}\n${body}`)
  writeFileSync(join(scratch, 'keys.rs'), readFileSync(join(ROOT, 'native/desktop/src/keys.rs')))
  const build = spawnSync(compiler, ['--edition=2021', '--test', source, '-o', binary], { encoding: 'utf8', timeout: 90_000, env: process.env })
  process.stdout.write(`${build.stdout ?? ''}${build.stderr ?? ''}`)
  check('the real native input control flow compiles against the recording backend', build.status === 0)
  if (build.status === 0) {
    const result = spawnSync(binary, ['--test-threads=1', '--nocapture'], { encoding: 'utf8', timeout: 30_000, env: process.env })
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    check('native input lifecycle and cancellation tests pass without OS input', result.status === 0)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`native input lifecycle: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
