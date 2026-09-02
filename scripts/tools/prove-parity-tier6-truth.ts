#!/usr/bin/env bun
// ============================================================================
//  prove-parity-tier6-truth — frontier-sweep #1, tier 6 mechanism:
//  the clean-tree fact derives from the tree, never from local config. A
//  repo-local `status.showUntrackedFiles=no` must not hide untracked work
//  from getIsClean — the fact feeds the health certificate's dirty flag.
// ============================================================================
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const repo = mkdtempSync(join(tmpdir(), 'parity-t6-repo-'))
const git = (...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}
git('init', '-q')
git('config', 'user.email', 'p@p')
git('config', 'user.name', 'parity')
writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
git('add', '-A')
git('commit', '-qm', 'seed')

const previousCwd = process.cwd()
process.chdir(repo)
const { getIsClean } = await import('../../src/utils/git.ts')

t('a committed tree reads clean', (await getIsClean()) === true)

writeFileSync(join(repo, 'untracked.txt'), 'new work\n')
t('untracked work reads dirty', (await getIsClean()) === false)

git('config', 'status.showUntrackedFiles', 'no')
t(
  'repo-local showUntrackedFiles=no cannot fake a clean verdict',
  (await getIsClean()) === false,
)
t(
  'the explicit ignoreUntracked caller still gets its narrow question answered',
  (await getIsClean({ ignoreUntracked: true })) === true,
)

process.chdir(previousCwd)
rmSync(repo, { recursive: true, force: true })
process.exit(failures)
