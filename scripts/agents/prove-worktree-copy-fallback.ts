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
const copyFallbackWhere = 'what to change: linkCheckoutDirectories in src/platform/git/worktree/worktree.ts, the copy fallback it takes when symlink is denied (EPERM), and the symlinkDirectories entries it reads'
const copy = fs.cp
const settings = await import('../../src/platform/settings/settings.js')
mock.module('../../src/platform/settings/settings.js', () => ({
  ...settings,
  getInitialSettings: () => ({ workspace: { worktree: { symlinkDirectories: ['deps', 'vendor/pack', 'exists', 'missing', '../outside'] } } }),
}))
mock.module('node:fs/promises', () => ({
  ...fs,
  symlink: async (_from: string, to: string) => { throw Object.assign(new Error('fixture link refused'), { code: to.endsWith('missing') ? 'ENOENT' : 'EPERM' }) },
  cp: async (from: string, to: string, options: Parameters<typeof fs.cp>[2]) => { copied.push(to); return copy(from, to, options) },
}))
const { prepareWorktreeFiles } = await import('../../src/platform/git/worktree/worktree.js')
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
  assert.equal(readFileSync(join(target, 'deps', 'marker'), 'utf8'), 'source dependency', `the denied link must fall back to a copy of deps; ${copyFallbackWhere}`)
  assert.equal(readFileSync(join(target, 'vendor', 'pack', 'marker'), 'utf8'), 'source pack', `the nested vendor/pack entry must be copied; ${copyFallbackWhere}`)
  assert.equal(lstatSync(join(target, 'deps')).isSymbolicLink(), false, `the fallback must leave a real directory, not a link; ${copyFallbackWhere}`)
  if (existsSync(join(source, 'deps', 'linked-marker'))) assert.equal(lstatSync(join(target, 'deps', 'linked-marker')).isSymbolicLink(), false, `links inside the copied directory must be dereferenced (cp with dereference: true); ${copyFallbackWhere}`)
  assert.deepEqual(copied.sort(), [join(target, 'deps'), join(target, 'vendor', 'pack')].sort(), `only deps and vendor/pack may be copied; ${copyFallbackWhere}`)
  assert.equal(readFileSync(join(target, 'exists', 'marker'), 'utf8'), 'keep target', `an entry that already exists in the worktree must be kept, not overwritten; ${copyFallbackWhere}`)
  assert.equal(existsSync(join(root, 'outside')), false, `a ../ entry must be skipped by the path-traversal check; ${copyFallbackWhere}`)
  writeFileSync(join(target, 'deps', 'marker'), 'worktree edit')
  assert.equal(readFileSync(join(source, 'deps', 'marker'), 'utf8'), 'source dependency', `editing the copy must not change the source, so the copy must not alias it; ${copyFallbackWhere}`)
  rmSync(target, { recursive: true, force: true })
  assert.equal(readFileSync(join(source, 'vendor', 'pack', 'marker'), 'utf8'), 'source pack', `removing the worktree must leave the source intact; ${copyFallbackWhere}`)
  console.log('PASS denied Windows links copy dependencies without symlink privilege; edits and cleanup leave the source intact')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  copied.length = 0
  await prepareWorktreeFiles(source, target)
  assert.equal(copied.length, 0, `on a POSIX platform a refused link must not become a copy; ${copyFallbackWhere}`)
  assert.equal(existsSync(join(target, 'deps')), false, `a refused link on a POSIX platform must leave no deps in the worktree; ${copyFallbackWhere}`)
  console.log('PASS existing targets, missing sources, traversal and POSIX refusals do not become copies')
} finally {
  Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
}
