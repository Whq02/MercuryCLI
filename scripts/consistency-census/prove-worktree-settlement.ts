#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const wt = await import('../../src/platform/git/worktree/worktree.ts')
const reminder = await import('../../src/crew/crewmates/crewWorktreeReminder.ts')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')

{
  const z = [
    ' M src/a.ts',
    'R  new.ts', 'old.ts',
    '?? notes.md',
    '?? .mercury/cache-clock/sessions/x.json',
    '?? .othertool/cache-clock/sessions/y.json',
  ].join('\0') + '\0'
  const c = wt.classifyPorcelainRecords(z)
  check('§A tracked: modify + rename both sides', c.tracked.length === 3, '', 'fix classifyPorcelainRecords in src/platform/git/worktree/delta.ts so a rename counts both its sides as tracked')
  check('§A authored untracked separated: a foreign-named dir is a project file, never Mercury-ephemeral', c.untrackedAuthored.length === 2 && c.untrackedAuthored.includes('notes.md'), '', 'fix classifyPorcelainRecords in src/platform/git/worktree/delta.ts so only paths under .mercury count as Mercury-ephemeral and other untracked paths stay authored')
  check('§A Mercury cache-clock debris classes as Mercury-ephemeral', c.mercuryEphemeral.length === 1, '', 'fix classifyPorcelainRecords in src/platform/git/worktree/delta.ts so .mercury/cache-clock paths class as Mercury-ephemeral')
}

function mkRepo(): { repo: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'unison-w2-repo-')))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'w2@fixture')
  git(repo, 'config', 'user.name', 'w2')
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'seed')
  return { repo }
}
type Lane = { lane: string; branch: string; slug: string }
let laneN = 0
function mkLane(repo: string): Lane {
  const slug = `agent-a${String(++laneN).padStart(7, '0')}`
  const branch = wt.worktreeBranchName(slug)
  const lane = join(repo, '.mercury', 'worktrees', slug)
  git(repo, 'worktree', 'add', '-q', '-b', branch, lane, 'HEAD')
  return { lane, branch, slug }
}
const DAY = 86_400_000
const read = (repo: string, at: Lane) =>
  reminder.crewWorktreeLeftoverOf({ name: at.slug, path: at.lane, branch: at.branch, gitRoot: repo }, Date.now())
const sweep = (repo: string, lane?: string): Promise<number> => {
  const old = new Date(Date.now() - 9 * DAY)
  if (lane !== undefined && existsSync(lane)) utimesSync(lane, old, old)
  return runWithCwdOverride(repo, () => wt.cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * DAY)))
}
const branchThere = (repo: string, branch: string): boolean => {
  try {
    git(repo, 'rev-parse', '--verify', branch)
    return true
  } catch {
    return false
  }
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  mkdirSync(join(at.lane, '.mercury', 'cache-clock', 'sessions'), { recursive: true })
  writeFileSync(join(at.lane, '.mercury', 'cache-clock', 'sessions', 's.json'), '{}\n')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§B runtime-only lane SETTLES', left.state === 'clean' && taken === 1, `${left.state} · ${taken} taken`, 'a lane holding only Mercury runtime files must read clean in crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) and be removed by cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts)')
  check('§B worktree absent', !existsSync(at.lane), '', 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must remove the settled lane directory')
  check('§B branch absent', !branchThere(repo, at.branch), '', 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must delete the settled lane branch')
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§C pristine lane settles', left.state === 'clean' && taken === 1 && !existsSync(at.lane), `${left.state} · ${taken} taken`, 'a lane with no changes must read clean in crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) and be taken once by cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts)')
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'work.ts'), 'x\n')
  git(at.lane, 'add', '.')
  git(at.lane, 'commit', '-q', '-m', 'authored')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§D commit preserves', left.state === 'unreachable' && taken === 0 && existsSync(at.lane), `${left.state} · ${taken} taken`, 'a lane holding a commit must read unreachable in crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) and cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must leave it')
  check('§D named', left.detail.includes('1 commit'), left.detail, 'the detail from crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) must name the commit count')
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'README.md'), 'edited\n')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§E tracked edit preserves + names the path', left.state === 'uncommitted' && left.detail.includes('README.md') && taken === 0 && existsSync(at.lane), `${left.state} · ${left.detail} · ${taken} taken`, 'a tracked edit must read uncommitted and name its path in crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts), and cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must leave the lane')
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'idea.txt'), 'x')
  const left = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  check('§F one-byte authored file preserved AND named', left.state === 'uncommitted' && left.detail.includes('idea.txt') && taken === 0, `${left.state} · ${left.detail} · ${taken} taken`, 'an untracked authored file of any size must read uncommitted and be named by crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts), and cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must leave the lane')
  check('§F lane + branch still present', existsSync(at.lane) && branchThere(repo, at.branch), '', 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must not remove a lane or branch holding authored work')
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  writeFileSync(join(at.lane, 'notes.md'), 'keep me\n')
  mkdirSync(join(at.lane, '.mercury', 'cache-clock', 'sessions'), { recursive: true })
  writeFileSync(join(at.lane, '.mercury', 'cache-clock', 'sessions', 's.json'), '{}\n')
  const left = await read(repo, at)
  const delta = await wt.readWorktreeDelta(at.lane)
  const taken = await sweep(repo, at.lane)
  check('§G mixed preserves', left.state === 'uncommitted' && taken === 0 && existsSync(at.lane), `${left.state} · ${taken} taken`, 'a lane with authored and runtime files must read uncommitted in crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) and cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must leave it')
  check(
    '§G delta separates authored from runtime',
    delta.untrackedAuthored.includes('notes.md') &&
      delta.mercuryEphemeral.some(p => p.includes('cache-clock')) &&
      left.detail.includes('notes.md') &&
      !left.detail.includes('cache-clock'),
    left.detail,
    'readWorktreeDelta (src/platform/git/worktree/delta.ts) must split authored from Mercury-ephemeral paths, and the leftover detail from crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) must list only authored paths',
  )
}

{
  const dir = mkdtempSync(join(tmpdir(), 'unison-w2-notgit-'))
  const d = await wt.readWorktreeDelta(dir)
  check('§H non-repo dir ⇒ uncertainty (never a clean-looking delta)', d.uncertainty !== null, '', 'readWorktreeDelta in src/platform/git/worktree/delta.ts must set uncertainty for a directory that is not a git repo')
  const left = await reminder.crewWorktreeLeftoverOf({ name: 'not-git', path: dir }, Date.now())
  check('§H a folder git does not own reads unowned, never clean', left.state === 'unowned', left.state, 'crewWorktreeLeftoverOf in src/crew/crewmates/crewWorktreeReminder.ts must read a folder git does not own as unowned')
}

{
  const { repo } = mkRepo()
  const gone = join(tmpdir(), `unison-w2-gone-${Date.now()}`)
  const left = await reminder.crewWorktreeLeftoverOf({ name: 'gone', path: gone, branch: 'none', gitRoot: repo }, Date.now())
  const taken = await sweep(repo)
  check('§I missing lane is not a silent success', left.state !== 'clean' && taken === 0, `${left.state} · ${taken} taken`, 'crewWorktreeLeftoverOf in src/crew/crewmates/crewWorktreeReminder.ts must not read a missing lane as clean, and cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must take none')
}

{
  const { repo } = mkRepo()
  const at = mkLane(repo)
  const first = await read(repo, at)
  const taken = await sweep(repo, at.lane)
  const second = await read(repo, at)
  const again = await sweep(repo, at.lane)
  check(
    '§J second settle is visible non-success (idempotent-safe)',
    first.state === 'clean' && taken === 1 && second.state !== 'clean' && again === 0,
    `${first.state} · ${taken} taken · ${second.state} · ${again} taken`,
    'after a lane is settled, crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) must read it as not clean and a second cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must take none',
  )
}


if (process.platform === 'win32') {
  const { symlinkSync, openSync, closeSync } = await import('node:fs')
  {
    const { repo } = mkRepo()
    const at = mkLane(repo)
    const junction = join(mkdtempSync(join(tmpdir(), 'unison-w2-junc-')), 'via')
    symlinkSync(at.lane, junction, 'junction')
    const left = await read(repo, { ...at, lane: junction })
    check('§N1 junction-reached pristine lane reads clean (a typed state — never silent)', left.state === 'clean', left.state, 'crewWorktreeLeftoverOf in src/crew/crewmates/crewWorktreeReminder.ts must read a pristine lane reached through a junction as clean')
  }
  {
    const { repo } = mkRepo()
    const at = mkLane(repo)
    const fd = openSync(join(at.lane, 'README.md'), 'r')
    const taken = await sweep(repo, at.lane)
    check(
      '§N2 open-handle settlement is typed, never a silent success claim',
      (taken === 1 && !existsSync(at.lane)) || (taken === 0 && existsSync(at.lane)),
      `${taken} taken`,
      'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must either remove a lane with an open handle or leave it whole, never half remove it',
    )
    closeSync(fd)
    if (taken !== 1) {
      const again = await sweep(repo, at.lane)
      check('§N2 settlement completes once the handle releases', again === 1 && !existsSync(at.lane), `${again} taken`, 'cleanupStaleAgentWorktrees in src/platform/git/worktree/worktree.ts must remove the lane on the next sweep once the handle is closed')
    }
  }
} else {
  console.log('  [SKIP] §N windows path/handle legs (posix host — the windows-functional lane runs them)')
}

console.log(failed === 0 ? '\n ✅ WORKTREE SETTLEMENT LAWS HOLD' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
