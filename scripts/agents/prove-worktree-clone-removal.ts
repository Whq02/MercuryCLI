#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneRoadExpected } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_WORKTREE_CLONE
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { cleanupStaleAgentWorktrees, cleanupWorktree, createAgentWorktree, createWorktreeForSession, getCurrentWorktreeSession, unlockAgentWorktree } = await import('../../src/utils/worktree.ts')
const { ensureWorkerWorktree, reapWorkerWorktree } = await import('../../src/daemon/concourseWorktrees.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-removal-')))
const cloneRoad = cloneRoadExpected(scratch)
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const registered = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
const setAside = (parent: string, home: string): string[] => (existsSync(parent) ? readdirSync(parent).filter(name => name.startsWith(`${home}.removing-`)) : [])
const gone = async (parent: string, home: string): Promise<boolean> => {
  const until = Date.now() + 60_000
  while (setAside(parent, home).length > 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100))
  return setAside(parent, home).length === 0
}
const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
}
const makeCheckout = (dir: string, dependencyFiles: number): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [name, body] of Object.entries({ '.gitignore': 'node_modules/\nvendor/*/\n.mercury/\n', 'package.json': '{"name":"removal-fixture"}', 'vendor/pack-a.lock.json': '{}\n' })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  const body = Buffer.alloc(512, 'd')
  for (let made = 0, pkg = 0; made < dependencyFiles; pkg++) {
    const home = join(dir, 'node_modules', `pkg-${pkg}`, 'lib')
    mkdirSync(home, { recursive: true })
    for (let index = 0; index < 20 && made < dependencyFiles; index++, made++) writeFileSync(join(home, `m${index}.js`), body)
  }
  mkdirSync(join(dir, 'vendor', 'pack-a'))
  writeFileSync(join(dir, 'vendor', 'pack-a', 'marker'), 'pack\n')
}
const adminFile = (repo: string, slug: string, name: string): string => join(repo, '.git', 'worktrees', slug, name)

const repo = join(scratch, 'repo')
makeCheckout(repo, 6000)
const estate = join(repo, '.mercury')
enter(repo)
state.setIsInteractive(true)
config.enableConfigs()

section('§1 a copy records what it holds as clones, beside its base commit')
const noted = await createAgentWorktree('agent-ab100001')
const record = existsSync(adminFile(repo, 'agent-ab100001', 'WORKTREE_CLONES')) ? readFileSync(adminFile(repo, 'agent-ab100001', 'WORKTREE_CLONES'), 'utf8') : '<absent>'
if (cloneRoad) check('the record names the two cloned folders, one a line', record === 'node_modules\nvendor/pack-a\n', JSON.stringify(record))
else {
  skip('this volume or platform cannot clone: nothing is cloned, nothing is recorded')
  check('a linked copy records nothing', record === '<absent>', JSON.stringify(record))
}
process.env.MERCURY_WORKTREE_CLONE = 'off'
const plain = await createAgentWorktree('agent-ab100002')
delete process.env.MERCURY_WORKTREE_CLONE
check('a copy made of links records nothing', !existsSync(adminFile(repo, 'agent-ab100002', 'WORKTREE_CLONES')) && lstatSync(join(plain.worktreePath, 'node_modules')).isSymbolicLink())

section('§2 leaving a session worktree that holds clones: the tree is set aside, git drops it, the delete runs apart')
const session = await createWorktreeForSession('proof-session', 'leave-clone')
const sessionPath = session.worktreePath
let started = performance.now()
await cleanupWorktree()
const leftIn = performance.now() - started
const asideAtReturn = setAside(estate, 'worktrees')
console.log(`  the removal returned in ${leftIn.toFixed(0)} ms; set aside at that moment: ${asideAtReturn.join(', ') || 'nothing'}`)
check('the worktree path is gone when the removal returns', !existsSync(sessionPath))
check('git no longer lists it and its branch is deleted', !registered(repo).includes(sessionPath) && git(repo, 'branch', '--list', 'worktree-leave-clone') === '')
check('the session holds no worktree', getCurrentWorktreeSession() === null)
if (cloneRoad) {
  check('the tree was set aside beside the worktrees home, not deleted while the caller waited', asideAtReturn.length === 1 && asideAtReturn[0]!.startsWith('worktrees.removing-leave-clone-'), asideAtReturn.join(', '))
  check('…and the tree set aside is deleted without anyone waiting for it', await gone(estate, 'worktrees'), setAside(estate, 'worktrees').join(', '))
} else {
  skip('this volume or platform cannot clone: the worktree holds links and is removed in place, as before')
  check('nothing is set aside', asideAtReturn.length === 0)
}

section('§3 a removal git refuses leaves the tree whole where it was')
const locked = await createWorktreeForSession('proof-session', 'leave-locked')
writeFileSync(join(locked.worktreePath, 'authored.txt'), 'kept\n')
git(repo, 'worktree', 'lock', locked.worktreePath, '--reason', 'held by another')
const refused = await refusal(() => cleanupWorktree())
check('the removal of a locked worktree is refused in git\'s words', refused.includes('locked'), refused)
check('the tree is back at its path with its files, its dependency folder and its registration', existsSync(join(locked.worktreePath, 'authored.txt')) && existsSync(join(locked.worktreePath, 'node_modules', 'pkg-0', 'lib', 'm0.js')) && registered(repo).includes(locked.worktreePath) && git(locked.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'worktree-leave-locked')
check('nothing is left set aside by the refusal', setAside(estate, 'worktrees').length === 0, setAside(estate, 'worktrees').join(', '))
check('the session still holds it', getCurrentWorktreeSession()?.worktreePath === locked.worktreePath)
git(repo, 'worktree', 'unlock', locked.worktreePath)
process.chdir(locked.worktreePath)
await cleanupWorktree()
check('once unlocked it is removed', !existsSync(locked.worktreePath) && (await gone(estate, 'worktrees')))

section('§4 the janitor removes an old clean lane the same way, and sweeps what an interrupted delete left')
const stale = await createAgentWorktree('agent-ab400001')
await unlockAgentWorktree(stale.worktreePath, repo)
const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
utimesSync(stale.worktreePath, nineDaysAgo, nineDaysAgo)
const oldDebris = join(estate, 'worktrees.removing-agent-ab400009-1-abc')
const freshDebris = join(estate, 'worktrees.removing-agent-ab400008-1-abc')
mkdirSync(join(oldDebris, 'node_modules'), { recursive: true })
mkdirSync(join(freshDebris, 'node_modules'), { recursive: true })
utimesSync(oldDebris, nineDaysAgo, nineDaysAgo)
const removedCount = await cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))
check('the janitor removes the old lane and its branch', !existsSync(stale.worktreePath) && git(repo, 'branch', '--list', 'worktree-agent-ab400001') === '' && removedCount >= 1, String(removedCount))
check('…and a tree left set aside for longer than the retention is swept', !existsSync(oldDebris), String(removedCount))
check('…while one set aside just now is left to its own delete', existsSync(freshDebris))
rmSync(freshDebris, { recursive: true, force: true })
check('the lanes made a moment ago are untouched', existsSync(noted.worktreePath) && existsSync(plain.worktreePath))

section('§5 a worktree that holds links is removed in place, as before')
process.env.MERCURY_WORKTREE_CLONE = 'off'
const linkedSession = await createWorktreeForSession('proof-session', 'leave-link')
delete process.env.MERCURY_WORKTREE_CLONE
await gone(estate, 'worktrees')
await cleanupWorktree()
check('the path is gone and nothing was ever set aside', !existsSync(linkedSession.worktreePath) && setAside(estate, 'worktrees').length === 0, setAside(estate, 'worktrees').join(', '))
check('the checkout\'s own dependency folder is untouched by the removal', existsSync(join(repo, 'node_modules', 'pkg-0', 'lib', 'm0.js')))

section('§6 a read-only folder inside a clone does not keep the copy')
const sealed = await createWorktreeForSession('proof-session', 'leave-sealed')
if (cloneRoad && process.getuid?.() !== 0) {
  chmodSync(join(sealed.worktreePath, 'node_modules', 'pkg-1', 'lib'), 0o555)
  const sealedRefusal = await refusal(() => cleanupWorktree())
  check('the removal succeeds', sealedRefusal === '' && !existsSync(sealed.worktreePath), sealedRefusal)
  check('…and the tree set aside is deleted, the read-only folder with it', await gone(estate, 'worktrees'), setAside(estate, 'worktrees').join(', '))
} else {
  skip('no clone here, or this user writes every folder: the link holds no folder of its own')
  await cleanupWorktree()
  check('the worktree is removed', !existsSync(sealed.worktreePath))
}

section('§7 the daemon reaps a worker\'s worktree the same way')
const daemonHome = join(scratch, 'daemon')
mkdirSync(daemonHome)
const worker = await ensureWorkerWorktree(repo, 'runner-clone', daemonHome)
check('the worker worktree is made', worker.ok === true, JSON.stringify(worker))
if (worker.ok) {
  const workerHoldsClone = lstatSync(join(worker.path, 'node_modules')).isDirectory() && !lstatSync(join(worker.path, 'node_modules')).isSymbolicLink()
  check('…with its dependency folder its own where the volume clones', workerHoldsClone === cloneRoad, String(workerHoldsClone))
  started = performance.now()
  const outcome = reapWorkerWorktree(repo, 'runner-clone', daemonHome)
  const reapedIn = performance.now() - started
  const asideInDaemon = setAside(daemonHome, 'worktrees')
  console.log(`  the reap returned in ${reapedIn.toFixed(0)} ms; set aside at that moment: ${asideInDaemon.join(', ') || 'nothing'}`)
  check('the reap answers reaped, the path is gone and git has dropped it', outcome.outcome === 'reaped' && !existsSync(worker.path) && !registered(repo).includes(worker.path), JSON.stringify(outcome))
  if (cloneRoad) {
    check('the tree was set aside in the daemon home, not deleted while the daemon waited', asideInDaemon.length === 1 && asideInDaemon[0]!.startsWith('worktrees.removing-runner-clone-'), asideInDaemon.join(', '))
    check('…and is deleted apart', await gone(daemonHome, 'worktrees'))
  } else {
    skip('this volume or platform cannot clone: the worker worktree is removed in place, as before')
    check('nothing is set aside', asideInDaemon.length === 0)
  }
}

enter(ROOT)
await gone(estate, 'worktrees')
if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
