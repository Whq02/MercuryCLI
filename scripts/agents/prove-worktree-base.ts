#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { createAgentWorktree, createWorktreeForSession, keepWorktree } = await import('../../src/utils/worktree.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-base-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitCode = (cwd: string, ...args: string[]): number => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).status ?? 1
const headOf = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD')
const isDetached = (cwd: string): boolean => gitCode(cwd, 'symbolic-ref', '-q', 'HEAD') !== 0
const baselineOf = (worktreePath: string): string | null => {
  try {
    const pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim()
    if (!pointer.startsWith('gitdir:')) return null
    return readFileSync(join(resolve(worktreePath, pointer.slice('gitdir:'.length).trim()), 'WORKTREE_BASE'), 'utf8').trim()
  } catch {
    return null
  }
}
const upstreamLines = (repo: string, branch: string): string =>
  spawnSync('git', ['config', '--get-regexp', `^branch\\.${branch.replace(/[.+]/g, '\\$&')}\\.`], { cwd: repo, encoding: 'utf8', env: gitEnv }).stdout.trim()
const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
type Cut = Awaited<ReturnType<typeof createAgentWorktree>>
const fulfilled = (outcomes: PromiseSettledResult<Cut>[]): Cut[] =>
  outcomes.filter((outcome): outcome is PromiseFulfilledResult<Cut> => outcome.status === 'fulfilled').map(outcome => outcome.value)
const refusals = (outcomes: PromiseSettledResult<Cut>[]): string =>
  outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => String(outcome.reason)).join(' | ')

const buildRepo = (name: string): { repo: string; first: string; head: string } => {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  const first = headOf(repo)
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  git(repo, 'commit', '-q', '-am', 'second')
  return { repo, first, head: headOf(repo) }
}

const unrelatedCommit = (repo: string): string => {
  git(repo, 'checkout', '-q', '--orphan', 'unrelated')
  git(repo, 'rm', '-rfq', '.')
  writeFileSync(join(repo, 'cut.txt'), 'initial public cut\n')
  git(repo, 'add', 'cut.txt')
  git(repo, 'commit', '-q', '-m', 'initial public cut')
  const sha = headOf(repo)
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'branch', '-Dq', 'unrelated')
  return sha
}

const enter = (repo: string): void => {
  process.chdir(repo)
  state.setOriginalCwd(repo)
  state.setCwdState(repo)
  state.setIsInteractive(true)
  config.enableConfigs()
}

section('§1 a stale refs/remotes/origin/main with no origin remote: the worktree stands at the checkout HEAD')
const stale = buildRepo('stale')
const unrelated = unrelatedCommit(stale.repo)
git(stale.repo, 'update-ref', 'refs/remotes/origin/main', unrelated)
git(stale.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
check('the fixture has no remote at all', git(stale.repo, 'remote') === '', git(stale.repo, 'remote'))
check('the fixture bookmark shares no commit with main', gitCode(stale.repo, 'merge-base', 'main', 'refs/remotes/origin/main') !== 0)
enter(stale.repo)
const lane = await createAgentWorktree('agent-a0000001')
check('the worktree lives under the repository worktrees home', lane.worktreePath.startsWith(join(stale.repo, '.mercury', 'worktrees')), lane.worktreePath)
check('the worktree HEAD is the checkout HEAD', headOf(lane.worktreePath) === stale.head, `${headOf(lane.worktreePath)} vs ${stale.head}`)
check('…not the stale bookmark', headOf(lane.worktreePath) !== unrelated && gitCode(lane.worktreePath, 'merge-base', '--is-ancestor', unrelated, 'HEAD') !== 0)
check('the result names the same commit', lane.headCommit === stale.head, String(lane.headCommit))
check('the baseline file records that sha', baselineOf(lane.worktreePath) === stale.head, String(baselineOf(lane.worktreePath)))
check('the worktree is on its own branch', !isDetached(lane.worktreePath) && lane.worktreeBranch === 'worktree-agent-a0000001', String(lane.worktreeBranch))
check('the branch carries no upstream', upstreamLines(stale.repo, 'worktree-agent-a0000001') === '', upstreamLines(stale.repo, 'worktree-agent-a0000001'))
check('the file in the worktree is the checkout file', readText(join(lane.worktreePath, 'a.txt')) === 'two\n')

section('§2 an origin remote whose main is ahead of the local main: the base is still the local HEAD, and no fetch runs')
const local = buildRepo('local')
const originRepo = join(scratch, 'origin.git')
git(scratch, 'clone', '-q', '--bare', local.repo, originRepo)
const originWork = join(scratch, 'origin-work')
git(scratch, 'clone', '-q', originRepo, originWork)
writeFileSync(join(originWork, 'a.txt'), 'three on the remote\n')
git(originWork, 'commit', '-q', '-am', 'third, only on the remote')
git(originWork, 'push', '-q', 'origin', 'main')
const remoteHead = headOf(originWork)
git(local.repo, 'remote', 'add', 'origin', originRepo)
git(local.repo, 'fetch', '-q', 'origin')
check('the fixture origin main is ahead of the local main', git(local.repo, 'rev-parse', 'refs/remotes/origin/main') === remoteHead && remoteHead !== local.head && gitCode(local.repo, 'merge-base', '--is-ancestor', local.head, remoteHead) === 0)
const fetchHead = join(local.repo, '.git', 'FETCH_HEAD')
rmSync(fetchHead, { force: true })
enter(local.repo)
const ahead = await createAgentWorktree('agent-a0000002')
check('with the remote-tracking ref present the worktree HEAD is the local HEAD', headOf(ahead.worktreePath) === local.head, `${headOf(ahead.worktreePath)} vs ${local.head}`)
check('…not the remote main', headOf(ahead.worktreePath) !== remoteHead)
check('the baseline records the local HEAD', baselineOf(ahead.worktreePath) === local.head, String(baselineOf(ahead.worktreePath)))
check('the branch carries no upstream', upstreamLines(local.repo, 'worktree-agent-a0000002') === '', upstreamLines(local.repo, 'worktree-agent-a0000002'))
check('no fetch ran (FETCH_HEAD stays absent)', !existsSync(fetchHead))
git(local.repo, 'update-ref', '-d', 'refs/remotes/origin/main')
rmSync(fetchHead, { force: true })
const aheadNoRef = await createAgentWorktree('agent-a0000003')
check('with the remote-tracking ref absent the worktree HEAD is still the local HEAD', headOf(aheadNoRef.worktreePath) === local.head, `${headOf(aheadNoRef.worktreePath)} vs ${local.head}`)
check('…and still no fetch ran', !existsSync(fetchHead))
check('the remote-tracking ref was not recreated', gitCode(local.repo, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main') !== 0)

section('§3 the pinned road stands at the pinned commit whatever the stale bookmark says')
enter(stale.repo)
const pinned = await createAgentWorktree('agent-a0000004', { at: stale.first })
check('the worktree HEAD is the pin', headOf(pinned.worktreePath) === stale.first, `${headOf(pinned.worktreePath)} vs ${stale.first}`)
check('…detached, with no branch', isDetached(pinned.worktreePath) && pinned.worktreeBranch === undefined)
check('the baseline records the pin', baselineOf(pinned.worktreePath) === stale.first, String(baselineOf(pinned.worktreePath)))
check('the result names the pin', pinned.headCommit === stale.first)
check('the pinned tree reads the pinned file', readText(join(pinned.worktreePath, 'a.txt')) === 'one\n')

section('§4 six creations launched together in one process, on a repository with a configured origin and its remote-tracking ref, all succeed, each at HEAD')
git(local.repo, 'update-ref', 'refs/remotes/origin/main', remoteHead)
enter(local.repo)
const sixSlugs = Array.from({ length: 6 }, (_, index) => `agent-a100000${index}`)
const six = await Promise.allSettled(sixSlugs.map(slug => createAgentWorktree(slug)))
const sixOk = fulfilled(six)
check('all six creations succeed', sixOk.length === 6, refusals(six))
check('six distinct worktrees', new Set(sixOk.map(cut => cut.worktreePath)).size === 6)
check('each stands at the checkout HEAD', sixOk.length === 6 && sixOk.every(cut => headOf(cut.worktreePath) === local.head), sixOk.map(cut => headOf(cut.worktreePath).slice(0, 7)).join(','))
check('each baseline records the checkout HEAD', sixOk.length === 6 && sixOk.every(cut => baselineOf(cut.worktreePath) === local.head))
check('each is on its own branch with no upstream', sixSlugs.every(slug => upstreamLines(local.repo, `worktree-${slug}`) === '' && gitCode(local.repo, 'rev-parse', '--verify', '-q', `refs/heads/worktree-${slug}`) === 0))
const registry = git(local.repo, 'worktree', 'list', '--porcelain')
check('git lists all six', sixOk.length === 6 && sixOk.every(cut => registry.includes(`worktree ${realpathSync(cut.worktreePath)}`) || registry.includes(`worktree ${cut.worktreePath}`)))
check('the shared config holds no lock afterwards', !existsSync(join(local.repo, '.git', 'config.lock')))
const sixPinned = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => createAgentWorktree(`agent-a200000${index}`, { at: local.first })))
const sixPinnedOk = fulfilled(sixPinned)
check('six pinned creations launched together all succeed', sixPinnedOk.length === 6, refusals(sixPinned))
check('each pinned one stands at the pin, detached', sixPinnedOk.length === 6 && sixPinnedOk.every(cut => headOf(cut.worktreePath) === local.first && isDetached(cut.worktreePath)))

section('§5 a ref lock another process holds for a moment: creation waits it out')
const lockSlug = 'agent-a3000000'
mkdirSync(join(stale.repo, '.git', 'refs', 'heads'), { recursive: true })
const heldLock = join(stale.repo, '.git', 'refs', 'heads', `worktree-${lockSlug}.lock`)
writeFileSync(heldLock, '')
const release = setTimeout(() => {
  try {
    unlinkSync(heldLock)
  } catch {
    return
  }
}, 300)
enter(stale.repo)
let lockedOutcome: Cut | null = null
let lockedRefusal = ''
try {
  lockedOutcome = await createAgentWorktree(lockSlug)
} catch (error) {
  lockedRefusal = error instanceof Error ? error.message : String(error)
}
clearTimeout(release)
check('the creation succeeds once the lock is released', lockedOutcome !== null, lockedRefusal)
check('…at the checkout HEAD', lockedOutcome !== null && headOf(lockedOutcome.worktreePath) === stale.head)

section('§6 the PR road: pull/<n>/head is fetched from origin and is the base')
git(originWork, 'checkout', '-q', '-b', 'feature')
writeFileSync(join(originWork, 'feature.txt'), 'from the pull request\n')
git(originWork, 'add', 'feature.txt')
git(originWork, 'commit', '-q', '-m', 'the pull request')
const prHead = headOf(originWork)
git(originWork, 'push', '-q', 'origin', 'feature:refs/pull/7/head')
enter(local.repo)
const pr = await createWorktreeForSession('proof-session', 'pr-7', undefined, { prNumber: 7 })
check('the PR worktree HEAD is the pull request head', headOf(pr.worktreePath) === prHead, `${headOf(pr.worktreePath)} vs ${prHead}`)
check('…which is not the local HEAD', prHead !== local.head)
check('the baseline records the pull request head', baselineOf(pr.worktreePath) === prHead, String(baselineOf(pr.worktreePath)))
check('the PR tree carries the pull request file', readText(join(pr.worktreePath, 'feature.txt')) === 'from the pull request\n')
await keepWorktree()

section("§7 a sub-agent launched from inside a worktree bases on that worktree's HEAD")
const laneRoot = join(scratch, 'lead-lane')
git(stale.repo, 'worktree', 'add', '-q', '-b', 'lane', laneRoot, stale.head)
writeFileSync(join(laneRoot, 'lane.txt'), 'on the lane\n')
git(laneRoot, 'add', 'lane.txt')
git(laneRoot, 'commit', '-q', '-m', 'lane work')
const laneHead = headOf(laneRoot)
check('the fixture lane is ahead of main', laneHead !== stale.head && headOf(stale.repo) === stale.head)
enter(stale.repo)
const fromLane = await createAgentWorktree('agent-a4000000', { from: laneRoot })
check("the worktree HEAD is the lane's HEAD", headOf(fromLane.worktreePath) === laneHead, `${headOf(fromLane.worktreePath)} vs ${laneHead}`)
check('…not the main checkout HEAD', headOf(fromLane.worktreePath) !== stale.head)
check('the baseline records the lane HEAD', baselineOf(fromLane.worktreePath) === laneHead)
check("it still lives under the repository's own worktrees home", fromLane.worktreePath.startsWith(join(stale.repo, '.mercury', 'worktrees')) && fromLane.gitRoot === stale.repo, `${fromLane.worktreePath} / ${String(fromLane.gitRoot)}`)
const fromLanePinned = await createAgentWorktree('agent-a4000001', { from: laneRoot, at: 'HEAD~1' })
check('a relative pin resolves in the launching worktree', headOf(fromLanePinned.worktreePath) === stale.head, headOf(fromLanePinned.worktreePath))

process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
