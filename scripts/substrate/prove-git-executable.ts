import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'git-executable-'))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const developer = process.env.DEVELOPER_DIR
let resolved = '/usr/bin/git'
mock.module('../../src/platform/processes/which.js', () => ({ whichSync: () => resolved }))
const { gitExe } = await import('../../src/platform/git/git.js')
try {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  process.env.DEVELOPER_DIR = scratch
  mkdirSync(join(scratch, 'usr/bin'), { recursive: true })
  const real = join(scratch, 'usr/bin/git')
  writeFileSync(real, '#!/bin/sh\nexit 0\n')
  chmodSync(real, 0o755)
  gitExe.cache.clear?.()
  assert.equal(gitExe(), real, 'the selected developer tool bypasses the xcrun shim; fix gitExe in src/platform/git/gitExe.ts to prefer usr/bin/git under DEVELOPER_DIR on darwin')
  rmSync(real)
  assert.equal(gitExe(), real, 'the resolved path is remembered once; gitExe in src/platform/git/gitExe.ts must stay memoized')
  gitExe.cache.clear?.()
  assert.equal(gitExe(), '/usr/bin/git', 'an unavailable explicit developer tool keeps the shim fallback; gitExe in src/platform/git/gitExe.ts must return the whichSync path when the DEVELOPER_DIR git is missing')
  resolved = '/opt/tools/git'
  gitExe.cache.clear?.()
  assert.equal(gitExe(), resolved, 'an earlier PATH git wins; gitExe in src/platform/git/gitExe.ts must return the whichSync path when it is not the /usr/bin/git shim')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  resolved = '/usr/bin/git'
  gitExe.cache.clear?.()
  assert.equal(gitExe(), resolved, 'other platforms retain their PATH executable; gitExe in src/platform/git/gitExe.ts must not apply the DEVELOPER_DIR lookup off darwin')
  console.log('git executable: PASS')
} finally {
  Object.defineProperty(process, 'platform', platform)
  if (developer === undefined) delete process.env.DEVELOPER_DIR
  else process.env.DEVELOPER_DIR = developer
  rmSync(scratch, { recursive: true, force: true })
}
