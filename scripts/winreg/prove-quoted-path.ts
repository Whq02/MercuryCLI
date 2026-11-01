import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const { resolveExecutable } = await import('../../src/utils/which.js')
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
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first}";${second}` }), join(first, 'fixture.exe'))
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first}"` }), join(first, 'fixture.exe'))
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first}";"${second}"` }), join(first, 'fixture.exe'))
  assert.equal(resolveExecutable('cwd-only', { platform: 'win32', path: `;"";"${first}";` }), null)
  assert.equal(resolveExecutable('fixture', { platform: 'win32', path: `"${first};${second}` }), join(second, 'fixture.exe'))
  assert.equal(resolveExecutable('fixture.exe', { platform: 'linux', path: `"${first}"` }), null)
  console.log('PASS quoted Windows PATH entries keep order; empty entries never search cwd; POSIX quotes stay literal')
} finally {
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
}
