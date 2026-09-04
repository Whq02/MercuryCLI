#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform === 'win32') {
  console.log('prove-board-dirt-cached: the shim legs need a posix shell — skipped on win32')
  process.exit(0)
}

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'board-dirt-'))
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
const isStatus = (r: Row): boolean => r.argv.includes(' status ')

const repo = join(SCRATCH, 'repo')
mkdirSync(repo)
git(repo, 'init', '-q')
writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'seed')
const BOUNDED = `-C ${repo} status --porcelain --untracked-files=normal -- .`

const wt = await import('../../src/daemon/concourseWorktrees.ts')

console.log('§1 the probe is bounded')
{
  const idx = join(repo, '.git', 'index')
  const idxBefore = statSync(idx).mtimeMs
  const n0 = mark()
  const dirt = wt.classifyWorktreeDirt(repo)
  const r = since(n0)
  check('the synchronous read issues one bounded status', r.length === 1 && r[0]!.argv === BOUNDED, r.map(x => x.argv).join(' | '))
  check('…and reads clean', dirt.kind === 'clean')
  check("…never touching the user's index (no refresh written)", statSync(idx).mtimeMs === idxBefore && !existsSync(join(repo, '.git', 'index.lock')))
}

console.log('§2 the words are cached')
const realNow = Date.now
{
  const n0 = mark()
  const first = wt.cachedWorktreeDirt(repo)
  check('the first cached read answers null (nothing claimed before the first answer)', first === null)
  await wt._worktreeDirtRefreshForTesting(repo)
  check('…and scheduled ONE bounded refresh', since(n0).filter(isStatus).length === 1 && since(n0).filter(isStatus)[0]!.argv === BOUNDED, since(n0).map(x => x.argv).join(' | '))
  const second = wt.cachedWorktreeDirt(repo)
  check('the second read paints the words (clean)', second?.kind === 'clean', JSON.stringify(second))
  writeFileSync(join(repo, 'authored.ts'), 'export const work = 1\n')
  const third = wt.cachedWorktreeDirt(repo)
  await wt._worktreeDirtRefreshForTesting(repo)
  check('inside the minute a read issues no git status, even after the tree changed', since(n0).filter(isStatus).length === 1 && third?.kind === 'clean', `${since(n0).filter(isStatus).length} status runs`)
}

console.log('§3 the refresh runs async, once per window')
{
  const n0 = mark()
  Date.now = () => realNow() + 61_000
  try {
    const fourth = wt.cachedWorktreeDirt(repo)
    check('past the window a read still paints the last words at once', fourth?.kind === 'clean')
    check('…with the refresh in flight behind it (nothing awaited by the reader)', since(n0).filter(isStatus).length <= 1)
    await wt._worktreeDirtRefreshForTesting(repo)
    check('…ONE refresh ran', since(n0).filter(isStatus).length === 1, `${since(n0).filter(isStatus).length}`)
    const fifth = wt.cachedWorktreeDirt(repo)
    check('…after which the words follow the tree (authored: authored.ts)', fifth?.kind === 'authored' && fifth.files.includes('authored.ts'), JSON.stringify(fifth))
    await wt._worktreeDirtRefreshForTesting(repo)
    check('…and a second read in the new window schedules nothing more', since(n0).filter(isStatus).length === 1)
  } finally {
    Date.now = realNow
  }
}

console.log('§4 the board paints from the cache; the reap keeps the synchronous read')
{
  const board = readFileSync(join(REPO_ROOT, 'src/services/concourse/coordinatorBoard.ts'), 'utf8')
  check("the board's main-checkout words ride cachedWorktreeDirt", board.includes('wt.cachedWorktreeDirt(workspaceId)') && !board.includes('wt.classifyWorktreeDirt('))
  const src = readFileSync(join(REPO_ROOT, 'src/daemon/concourseWorktrees.ts'), 'utf8')
  check('the reap still classifies synchronously (a reap sees the tree of its moment)', /dirt \?\?= classifyWorktreeDirt\(path\)/.test(src))
  check('one probe spelling for both roads (the sync read and the cached refresh)', (src.match(/\.\.\.DIRT_PROBE\)/g) ?? []).length === 2)
}

console.log('§5 the dirt law holds through the bounded probe')
{
  rmSync(join(repo, 'authored.ts'))
  const runtimeHome = wt.WORKTREE_RUNTIME_HOMES[0]!
  mkdirSync(join(repo, runtimeHome), { recursive: true })
  writeFileSync(join(repo, runtimeHome, 'settings.local.json'), '{}')
  const runtime = wt.classifyWorktreeDirt(repo)
  check('untracked runtime-home files classify RUNTIME-ONLY through the collapsed row', runtime.kind === 'runtime-only', JSON.stringify(runtime))
  mkdirSync(join(repo, 'newdir'), { recursive: true })
  writeFileSync(join(repo, 'newdir', 'a.ts'), 'a')
  writeFileSync(join(repo, 'newdir', 'b.ts'), 'b')
  const authored = wt.classifyWorktreeDirt(repo)
  check('an untracked directory collapses to one authored row (newdir/)', authored.kind === 'authored' && authored.files.length === 1 && authored.files[0] === 'newdir/', JSON.stringify(authored))
  writeFileSync(join(repo, 'tracked.txt'), 'v2\n')
  const tracked = wt.classifyWorktreeDirt(repo)
  check('a tracked modification is authored', tracked.kind === 'authored' && tracked.files.includes('tracked.txt'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-board-dirt-cached: ALL LAWS HOLD' : `\nprove-board-dirt-cached: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
