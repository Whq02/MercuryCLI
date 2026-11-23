#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform === 'win32') {
  console.log('prove-worktree-dirt-probe: the shim legs need a posix shell — skipped on win32')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'worktree-dirt-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
process.env.GIT_CONFIG_GLOBAL = join(SCRATCH, 'gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.XDG_CONFIG_HOME = join(SCRATCH, 'xdg')

const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
const SHIM_DIR = join(SCRATCH, 'shim')
mkdirSync(SHIM_DIR)
const LOG = join(SCRATCH, 'git.log')
writeFileSync(LOG, '')
writeFileSync(join(SHIM_DIR, 'git'), `#!/bin/bash\nprintf '%s\\t%s\\n' "$PWD" "$*" >> "${LOG}"\nexec "${REAL_GIT}" "$@"\n`)
chmodSync(join(SHIM_DIR, 'git'), 0o755)
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ''}`

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.email=prover@example.invalid', '-c', 'user.name=prover', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
type Row = { cwd: string; argv: string }
const rows = (): Row[] =>
  readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [cwd = '', ...argv] = l.split('\t')
      return { cwd, argv: argv.join('\t') }
    })
const mark = (): number => rows().length
const since = (n: number): Row[] => rows().slice(n)

const repo = join(SCRATCH, 'repo')
mkdirSync(repo)
git(repo, 'init', '-q')
writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'seed')
const wt = await import('../../src/daemon/concourse-workers/concourseWorktrees.ts')
const { projectScopePathspec } = await import('../../src/platform/files/projectBoundary.ts')
const { gitArgs } = await import('../../src/platform/git/spawnArgs.ts')
const BOUNDED = gitArgs(['-C', repo, 'status', '--porcelain', '--untracked-files=normal', ...projectScopePathspec(repo)], repo).join(' ')

console.log('§1 the probe is bounded')
{
  const idx = join(repo, '.git', 'index')
  const idxBefore = statSync(idx).mtimeMs
  const n0 = mark()
  const dirt = wt.classifyWorktreeDirt(repo)
  const r = since(n0)
  check('the synchronous read issues one bounded status with fold 46i spawn settings', r.length === 1 && r[0]!.argv === BOUNDED, `${r.map(x => x.argv).join(' | ')} — classifyWorktreeDirt in src/daemon/concourse-workers/concourseWorktrees.ts must run exactly one git status with the gitArgs settings and projectScopePathspec`)
  check('…and reads clean', dirt.kind === 'clean', `got ${JSON.stringify(dirt)}; classifyWorktreeDirt in src/daemon/concourse-workers/concourseWorktrees.ts must read a fresh commit as clean`)
  check("…never touching the user's index (no refresh written)", statSync(idx).mtimeMs === idxBefore && !existsSync(join(repo, '.git', 'index.lock')), 'the status call in classifyWorktreeDirt (src/daemon/concourse-workers/concourseWorktrees.ts) must not write the index, for example by omitting --no-optional-locks')
}


console.log('§3 the dirt law holds through the bounded probe')
{
  const runtimeHome = wt.WORKTREE_RUNTIME_HOMES[0]!
  mkdirSync(join(repo, runtimeHome), { recursive: true })
  writeFileSync(join(repo, runtimeHome, 'settings.local.json'), '{}')
  const runtime = wt.classifyWorktreeDirt(repo)
  check('untracked runtime-home files classify RUNTIME-ONLY through the collapsed row', runtime.kind === 'runtime-only', `${JSON.stringify(runtime)} — classifyWorktreeDirt in src/daemon/concourse-workers/concourseWorktrees.ts must treat files under WORKTREE_RUNTIME_HOMES as runtime-only`)
  mkdirSync(join(repo, 'newdir'), { recursive: true })
  writeFileSync(join(repo, 'newdir', 'a.ts'), 'a')
  writeFileSync(join(repo, 'newdir', 'b.ts'), 'b')
  const authored = wt.classifyWorktreeDirt(repo)
  check('an untracked directory collapses to one authored row (newdir/)', authored.kind === 'authored' && authored.files.length === 1 && authored.files[0] === 'newdir/', `${JSON.stringify(authored)} — classifyWorktreeDirt in src/daemon/concourse-workers/concourseWorktrees.ts must read an untracked directory as one authored row`)
  writeFileSync(join(repo, 'tracked.txt'), 'v2\n')
  const tracked = wt.classifyWorktreeDirt(repo)
  check('a tracked modification is authored', tracked.kind === 'authored' && tracked.files.includes('tracked.txt'), `got ${JSON.stringify(tracked)}; classifyWorktreeDirt in src/daemon/concourse-workers/concourseWorktrees.ts must report a modified tracked file as authored`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-worktree-dirt-probe: ALL LAWS HOLD' : `\nprove-worktree-dirt-probe: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
