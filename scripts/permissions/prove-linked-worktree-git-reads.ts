#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'linked-worktree-reads-')))
const before = process.cwd()
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()

const repo = join(scratch, 'repo')
mkdirSync(join(repo, 'refs'), { recursive: true })
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'refs', 'index.md'), 'a tracked folder named refs\n')
writeFileSync(join(repo, 'HEAD'), 'a tracked file named HEAD\n')
writeFileSync(join(repo, 'a.txt'), 'a\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-q', '-m', 'first')
const inside = join(repo, '.mercury', 'worktrees', 'agent-a1234567')
mkdirSync(join(repo, '.mercury', 'worktrees'), { recursive: true })
git(repo, 'worktree', 'add', '-q', '-B', 'worktree-agent-a1234567', inside, 'HEAD')
const outside = join(scratch, 'elsewhere', 'lane')
mkdirSync(join(scratch, 'elsewhere'), { recursive: true })
git(repo, 'worktree', 'add', '-q', '--detach', outside, 'HEAD')
const plainRepo = join(scratch, 'plain')
mkdirSync(plainRepo)
git(plainRepo, 'init', '-q', '-b', 'main')
writeFileSync(join(plainRepo, 'b.txt'), 'b\n')
git(plainRepo, 'add', '-A')
git(plainRepo, 'commit', '-q', '-m', 'first')
const plainLane = join(plainRepo, '.mercury', 'worktrees', 'agent-a7654321')
mkdirSync(join(plainRepo, '.mercury', 'worktrees'), { recursive: true })
git(plainRepo, 'worktree', 'add', '-q', '-B', 'worktree-agent-a7654321', plainLane, 'HEAD')
const bare = join(scratch, 'bare.git')
git(scratch, 'init', '-q', '--bare', bare)
const planted = join(scratch, 'planted')
mkdirSync(join(planted, 'evil'), { recursive: true })
writeFileSync(join(planted, '.git'), 'gitdir: ./evil\n')
writeFileSync(join(planted, 'evil', 'HEAD'), 'ref: refs/heads/main\n')
const plantedWorktree = join(scratch, 'planted-worktree')
mkdirSync(join(plantedWorktree, 'admin'), { recursive: true })
writeFileSync(join(plantedWorktree, '.git'), 'gitdir: ./admin\n')
writeFileSync(join(plantedWorktree, 'admin', 'HEAD'), 'ref: refs/heads/main\n')
writeFileSync(join(plantedWorktree, 'admin', 'commondir'), '..\n')

process.chdir(plainRepo)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.js')
bootstrap.setIsInteractive(false)
bootstrap.setCwdState(plainRepo)
await import('../../src/Tool.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { isCurrentDirectoryBareGitRepo } = await import('../../src/utils/git.js')
const { describeBashNotReadOnly } = await import('../../src/tools/BashTool/readOnlyValidation.js')

let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const prepare = (input: { command: string }) => BashTool.prepare!(input as never)
const safe = (input: { command: string }) => BashTool.isReadOnly(input as never) && BashTool.isConcurrencySafe(input as never)
const cwd = (path: string) => {
  process.chdir(path)
  bootstrap.setCwdState(path)
}
const watchdog = setTimeout(() => {
  console.error('linked-worktree-git-reads: timed out waiting for product marks')
  process.exit(1)
}, 60_000)

try {
  console.log('§1 the gate reads a linked worktree as an ordinary repository, on every layout')
  check('the main checkout of a repository that tracks refs/ and a file HEAD is not bare', isCurrentDirectoryBareGitRepo(repo) === false, isCurrentDirectoryBareGitRepo(repo))
  check('its linked worktree under .mercury/worktrees is not bare either', isCurrentDirectoryBareGitRepo(inside) === false, isCurrentDirectoryBareGitRepo(inside))
  check('its linked worktree outside the repository folder is not bare either', isCurrentDirectoryBareGitRepo(outside) === false, isCurrentDirectoryBareGitRepo(outside))
  check('a plain linked worktree (no bare-looking names in the tree) is not bare', isCurrentDirectoryBareGitRepo(plainLane) === false, isCurrentDirectoryBareGitRepo(plainLane))
  console.log('§2 a real bare repository and a planted redirect still go through the gate')
  check('a real bare repository reads as bare structure', isCurrentDirectoryBareGitRepo(bare) === 'bare-indicators', isCurrentDirectoryBareGitRepo(bare))
  check('a .git file redirecting into its own folder is plantable', isCurrentDirectoryBareGitRepo(planted) === 'gitdir-redirect-plantable', isCurrentDirectoryBareGitRepo(planted))
  check('a planted worktree-shaped admin dir (commondir pointing back inside the folder) is plantable', isCurrentDirectoryBareGitRepo(plantedWorktree) === 'gitdir-redirect-plantable', isCurrentDirectoryBareGitRepo(plantedWorktree))
  console.log('§3 the read-only road: git ls-files and git status inside the linked worktree are read-only (a read-only crewmate runs them); the bare repository still asks')
  cwd(inside)
  const ls = { command: 'git ls-files | wc -l' }
  await prepare(ls)
  check('`git ls-files | wc -l` inside the linked worktree is read-only', safe(ls), await describeBashNotReadOnly(ls.command))
  const status = { command: 'git status --porcelain' }
  await prepare(status)
  check('`git status --porcelain` inside the linked worktree is read-only', safe(status), await describeBashNotReadOnly(status.command))
  cwd(outside)
  const lsOutside = { command: 'git ls-files' }
  await prepare(lsOutside)
  check('`git ls-files` inside the linked worktree outside the repository folder is read-only', safe(lsOutside), await describeBashNotReadOnly(lsOutside.command))
  cwd(bare)
  const bareStatus = { command: 'git status' }
  await prepare(bareStatus)
  const bareReason = await describeBashNotReadOnly(bareStatus.command)
  check('`git status` inside a real bare repository is not read-only and says why', !safe(bareStatus) && JSON.stringify(bareReason).includes('bare-repository structure'), bareReason)
  console.log('§4 a drive-letter gitdir pointer on Windows resolves (the hardened resolver keeps the root instead of walking from a bare separator)')
  if (process.platform === 'win32') {
    check('the linked worktree under .mercury/worktrees on this Windows box is not bare', isCurrentDirectoryBareGitRepo(inside) === false, isCurrentDirectoryBareGitRepo(inside))
    check('the plain linked worktree on this Windows box is not bare', isCurrentDirectoryBareGitRepo(plainLane) === false, isCurrentDirectoryBareGitRepo(plainLane))
  } else {
    console.log(`[SKIP] the drive-letter walk needs a Windows host (this is ${process.platform}); §1 and §3 hold the law here`)
  }
} finally {
  clearTimeout(watchdog)
  process.chdir(before)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'prove-linked-worktree-git-reads: ALL LAWS HOLD' : `prove-linked-worktree-git-reads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
