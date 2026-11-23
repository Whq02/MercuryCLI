#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

let failures = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  const shown = ok ? detail : [detail, hint].filter(Boolean).join(' — ')
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown ? ` — ${shown}` : ''}`)
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
const { getIsClean } = await import('../../src/platform/git/git.ts')

t(
  'a committed tree reads clean',
  (await getIsClean()) === true,
  '',
  'getIsClean in src/platform/git/git.ts (probeClean) must return true on a freshly committed repo',
)

writeFileSync(join(repo, 'untracked.txt'), 'new work\n')
t(
  'untracked work reads dirty',
  (await getIsClean()) === false,
  '',
  'getIsClean in src/platform/git/git.ts must count untracked files by default (untrackedFiles "all")',
)

git('config', 'status.showUntrackedFiles', 'no')
t(
  'repo-local showUntrackedFiles=no cannot fake a clean verdict',
  (await getIsClean()) === false,
  '',
  'getIsClean in src/platform/git/git.ts must not let the repo config status.showUntrackedFiles=no hide untracked files; pass the untracked mode explicitly',
)
t(
  'the explicit ignoreUntracked caller still gets its narrow question answered',
  (await getIsClean({ ignoreUntracked: true })) === true,
  '',
  'getIsClean in src/platform/git/git.ts must honour options.ignoreUntracked (mode "no") and report clean when only untracked files exist',
)

process.chdir(previousCwd)
rmSync(repo, { recursive: true, force: true })
process.exit(failures)
