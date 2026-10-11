#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-count-')))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'worktree-count-home-'))
const repo = join(scratch, 'repo')
mkdirSync(repo)
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}
git(repo, 'init', '-q', '-b', 'main', '.')
writeFileSync(join(repo, 'README.md'), 'worktree count proof\n')
git(repo, 'add', '-A')
git(repo, '-c', 'user.email=wc@example.com', '-c', 'user.name=wc', 'commit', '-qm', 'init')
process.chdir(repo)

const fsMod = await import('../../src/utils/git/gitFilesystem.js')
const { setCwdState } = await import('../../src/bootstrap/state.js')
const countFrom = async (dir: string): Promise<number> => {
  setCwdState(dir)
  fsMod.clearResolveGitDirCache()
  return fsMod.getWorktreeCountFromFs()
}

console.log('the worktree count read from the filesystem')
check('a repository with no linked worktree counts its primary checkout alone', (await countFrom(repo)) === 1)
const lane = join(scratch, 'lane-one')
git(repo, 'worktree', 'add', '-q', '-b', 'lane-one', lane)
check('a linked worktree adds one', (await countFrom(repo)) === 2)
const second = join(scratch, 'lane-two')
git(repo, 'worktree', 'add', '-q', '-b', 'lane-two', second)
check('each linked worktree adds one more', (await countFrom(repo)) === 3)
check('read from inside a linked worktree the count is the same: the admin folder is the common dir', (await countFrom(lane)) === 3)
git(repo, 'worktree', 'remove', '--force', second)
check('a removed worktree is no longer counted', (await countFrom(repo)) === 2)
const plain = join(scratch, 'plain')
mkdirSync(plain)
check('a folder outside any repository counts nothing', (await countFrom(plain)) === 0)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ THE WORKTREE COUNT IS THE PRIMARY PLUS EVERY LINKED WORKTREE')
process.exit(0)
