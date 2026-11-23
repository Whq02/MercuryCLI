import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const { resolveExecutable } = await import('../../src/platform/processes/which.js')
const root = mkdtempSync(join(tmpdir(), 'quoted-path-'))
const originalCwd = process.cwd()
try {
  const first = join(root, 'first directory')
  const second = join(root, 'second directory')
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(join(first, 'fixture.exe'), '')
  writeFileSync(join(second, 'fixture.exe'), '')
  writeFileSync(join(root, 'cwd-only.exe'), '')
  process.chdir(root)
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first}";${second}` }), join(first, 'fixture.exe'), 'quoted first entry then plain entry: change resolveProgramInPath in src/platform/host-os/programs.ts so a quoted Windows PATH entry is unquoted and the entries keep their order')
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first}"` }), join(first, 'fixture.exe'), 'single quoted entry: change resolveProgramInPath in src/platform/host-os/programs.ts to strip the quotes from a Windows PATH entry before searching it')
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first}";"${second}"` }), join(first, 'fixture.exe'), 'two quoted entries: change resolveProgramInPath in src/platform/host-os/programs.ts so each quoted Windows PATH entry is unquoted and searched in order')
  assert.equal(resolveExecutable('cwd-only', { platform: 'win32', path: `;"";"${first}";` }), null, 'empty PATH entries must not search the current directory: change resolveProgramInPath in src/platform/host-os/programs.ts to skip empty and empty-quoted entries')
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first};${second}` }), join(second, 'fixture.exe'), 'unterminated quote: change resolveProgramInPath in src/platform/host-os/programs.ts so a stray opening quote leaves the later entries searchable')
  assert.equal(resolveExecutable('fixture.exe', { platform: 'linux', path: `"${first}"` }), null, 'POSIX quotes stay literal: change resolveProgramInPath in src/platform/host-os/programs.ts so only the win32 platform strips quotes from PATH entries')
  console.log('PASS quoted Windows PATH entries keep order; empty entries never search cwd; POSIX quotes stay literal')
} finally {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}
