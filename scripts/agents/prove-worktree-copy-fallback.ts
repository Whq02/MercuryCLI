import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const root = mkdtempSync(join(tmpdir(), 'worktree-copy-'))
const source = join(root, 'source')
const target = join(root, 'target')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const copied: string[] = []
const copy = fs.cp
const settings = await import('../../src/utils/settings/settings.js')
mock.module('../../src/utils/settings/settings.js', () => ({
  ...settings,
  getInitialSettings: () => ({ workspace: { worktree: { symlinkDirectories: ['deps', 'vendor/pack', 'exists', 'missing', '../outside'] } } }),
}))
mock.module('node:fs/promises', () => ({
  ...fs,
  symlink: async (_from: string, to: string) => { throw Object.assign(new Error('fixture link refused'), { code: to.endsWith('missing') ? 'ENOENT' : 'EPERM' }) },
  cp: async (from: string, to: string, options: Parameters<typeof fs.cp>[2]) => { copied.push(to); return copy(from, to, options) },
}))
const { prepareWorktreeFiles } = await import('../../src/utils/worktree.js')
try {
  mkdirSync(join(source, 'deps'), { recursive: true })
  mkdirSync(join(source, 'vendor', 'pack'), { recursive: true })
  mkdirSync(join(source, 'exists'), { recursive: true })
  mkdirSync(join(target, 'exists'), { recursive: true })
  writeFileSync(join(source, 'deps', 'marker'), 'source dependency')
  writeFileSync(join(source, 'vendor', 'pack', 'marker'), 'source pack')
  writeFileSync(join(target, 'exists', 'marker'), 'keep target')
  if (process.platform !== 'win32') symlinkSync(join(source, 'deps', 'marker'), join(source, 'deps', 'linked-marker'))
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  await prepareWorktreeFiles(source, target)
  assert.equal(readFileSync(join(target, 'deps', 'marker'), 'utf8'), 'source dependency')
  assert.equal(readFileSync(join(target, 'vendor', 'pack', 'marker'), 'utf8'), 'source pack')
  assert.equal(lstatSync(join(target, 'deps')).isSymbolicLink(), false)
  if (existsSync(join(source, 'deps', 'linked-marker'))) assert.equal(lstatSync(join(target, 'deps', 'linked-marker')).isSymbolicLink(), false)
  assert.deepEqual(copied.sort(), [join(target, 'deps'), join(target, 'vendor', 'pack')].sort())
  assert.equal(readFileSync(join(target, 'exists', 'marker'), 'utf8'), 'keep target')
  assert.equal(existsSync(join(root, 'outside')), false)
  writeFileSync(join(target, 'deps', 'marker'), 'worktree edit')
  assert.equal(readFileSync(join(source, 'deps', 'marker'), 'utf8'), 'source dependency')
  rmSync(target, { recursive: true, force: true })
  assert.equal(readFileSync(join(source, 'vendor', 'pack', 'marker'), 'utf8'), 'source pack')
  console.log('PASS denied Windows links copy dependencies without symlink privilege; edits and cleanup leave the source intact')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  copied.length = 0
  await prepareWorktreeFiles(source, target)
  assert.equal(copied.length, 0)
  assert.equal(existsSync(join(target, 'deps')), false)
  console.log('PASS existing targets, missing sources, traversal and POSIX refusals do not become copies')
} finally {
  Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
}
