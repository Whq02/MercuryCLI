#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { accountLinks, cloneRoadExpected, LINK_PRIVILEGE } from '../lib/cloneRoad.ts'

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
const { crewLeftoverWorktrees } = await import('../../src/utils/crew/crewWorktreeReminder.ts')
const clones = (await import('../../src/utils/worktreeClone.ts')) as Record<string, unknown>
const setWorktreeAside = clones.setWorktreeAside as ((path: string) => string | null) | undefined
const discardSetAside = clones.discardSetAside as ((path: string) => void) | undefined
const returnWorktreeFromAside = clones.returnWorktreeFromAside as ((aside: string, path: string) => void) | undefined

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-removal-')))
const links = accountLinks(scratch)
const cloneRoad = cloneRoadExpected(scratch)
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const registered = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
const setAside = (home: string): string[] => (existsSync(home) ? readdirSync(home).filter(name => name.startsWith('.removing-')) : [])
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const gone = async (home: string): Promise<boolean> => {
  const until = Date.now() + 60_000
  while (setAside(home).length > 0 && Date.now() < until) await wait(100)
  return setAside(home).length === 0
}
const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
const printedDuring = async (fn: () => Promise<unknown>): Promise<string> => {
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  let printed = ''
  process.stdout.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stderr.write
  try {
    await fn().catch(() => {})
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
  return printed
}
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
}
const makeCheckout = (dir: string, dependencyFiles: number): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [name, body] of Object.entries({ '.gitignore': 'node_modules/\nvendor/*/\n.mercury/worktrees/\n', 'package.json': '{"name":"removal-fixture"}', 'vendor/pack-a.lock.json': '{}\n' })) {
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
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000)

const repo = join(scratch, 'repo')
makeCheckout(repo, 6000)
const home = join(repo, '.mercury', 'worktrees')
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
if (!links) skip(`the links a copy is made of with no clone, and the fixture's own link to a file in §4: ${LINK_PRIVILEGE}`)
check(`a copy made of ${links ? 'links' : 'the folders this account gets in place of links'} records nothing`, !existsSync(adminFile(repo, 'agent-ab100002', 'WORKTREE_CLONES')) && (links ? lstatSync(join(plain.worktreePath, 'node_modules')).isSymbolicLink() : lstatSync(join(plain.worktreePath, 'node_modules')).isDirectory()))

section('§2 leaving a session worktree that holds clones: git drops it, the delete runs apart, nothing is printed (§7 holds that the tree is set aside, by a folder a delete in place could not take)')
const session = await createWorktreeForSession('proof-session', 'leave-clone')
const sessionPath = session.worktreePath
let started = performance.now()
const printedLeaving = await printedDuring(() => cleanupWorktree())
const leftIn = performance.now() - started
const asideAtReturn = setAside(home)
console.log(`  the removal returned in ${leftIn.toFixed(0)} ms; still set aside at that moment: ${asideAtReturn.join(', ') || 'nothing (its delete had already finished)'}`)
check('the worktree path is gone when the removal returns', !existsSync(sessionPath))
check('git no longer lists it and its branch is deleted', !registered(repo).includes(sessionPath) && git(repo, 'branch', '--list', 'worktree-leave-clone') === '')
check('the session holds no worktree', getCurrentWorktreeSession() === null)
check('the removal prints nothing', printedLeaving === '', JSON.stringify(printedLeaving.slice(0, 200)))
check('whatever stood set aside carries the name of the worktree it was, inside the worktrees home', asideAtReturn.every(name => name.startsWith('.removing-leave-clone-')), asideAtReturn.join(', '))
check('…and is deleted without anyone waiting for it', await gone(home), setAside(home).join(', '))
if (!cloneRoad) check('with no clone nothing is ever set aside', asideAtReturn.length === 0)

section('§3 a removal git refuses leaves the tree whole where it was, and prints nothing')
const locked = await createWorktreeForSession('proof-session', 'leave-locked')
writeFileSync(join(locked.worktreePath, 'authored.txt'), 'kept\n')
git(repo, 'worktree', 'lock', locked.worktreePath, '--reason', 'held by another')
let refused = ''
const printedRefusing = await printedDuring(async () => {
  refused = await refusal(() => cleanupWorktree())
})
check('the removal of a locked worktree is refused in git\'s words', refused.includes('locked'), refused)
check('the tree is back at its path with its files, its dependency folder and its registration', existsSync(join(locked.worktreePath, 'authored.txt')) && existsSync(join(locked.worktreePath, 'node_modules', 'pkg-0', 'lib', 'm0.js')) && registered(repo).includes(locked.worktreePath) && git(locked.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'worktree-leave-locked')
check('nothing is left set aside by the refusal', setAside(home).length === 0, setAside(home).join(', '))
check('the session still holds it', getCurrentWorktreeSession()?.worktreePath === locked.worktreePath)
check('the refusal prints nothing beside the error it throws', printedRefusing === '', JSON.stringify(printedRefusing.slice(0, 200)))
git(repo, 'worktree', 'unlock', locked.worktreePath)
rmSync(join(locked.worktreePath, 'authored.txt'))
process.chdir(locked.worktreePath)
await cleanupWorktree()
check('once unlocked it is removed', !existsSync(locked.worktreePath) && (await gone(home)))

section('§4 the delete takes the one tree it was handed and nothing through a link')
const outside = join(scratch, 'outside')
mkdirSync(join(outside, 'sealed'), { recursive: true })
writeFileSync(join(outside, 'keep.txt'), 'outside the tree\n')
writeFileSync(join(outside, 'sealed', 'inner.txt'), 'outside and read-only\n')
chmodSync(join(outside, 'sealed'), 0o555)
const outsideModeBefore = statSync(join(outside, 'sealed')).mode & 0o7777
const handed = await createAgentWorktree('agent-ab400002')
await unlockAgentWorktree(handed.worktreePath, repo)
let linkedOut = true
if (links) {
  symlinkSync(outside, join(handed.worktreePath, 'node_modules', 'link-out-of-the-tree'))
  symlinkSync(join(outside, 'keep.txt'), join(handed.worktreePath, 'node_modules', 'file-link-out'))
} else {
  try {
    symlinkSync(outside, join(handed.worktreePath, 'node_modules', 'link-out-of-the-tree'), 'junction')
  } catch {
    linkedOut = false
    skip('no junction could be made here either: the delete is handed no link out of the tree')
  }
}
if (cloneRoad && process.getuid?.() !== 0) chmodSync(join(handed.worktreePath, 'node_modules', 'pkg-1', 'lib'), 0o555)
const handedAside = setWorktreeAside?.(handed.worktreePath) ?? null
check('the product sets a tree aside under a name of its own inside the worktrees home', handedAside !== null && dirname(handedAside) === home && handedAside.includes('.removing-agent-ab400002-'), String(handedAside))
git(repo, 'worktree', 'remove', handed.worktreePath)
check('git drops the registration of the path that is gone', !registered(repo).includes(handed.worktreePath))
const impostor = join(home, 'not-set-aside')
mkdirSync(join(impostor, 'inside'), { recursive: true })
const strayHome = join(scratch, 'stray')
mkdirSync(join(strayHome, '.removing-looks-right', 'inside'), { recursive: true })
discardSetAside?.(impostor)
discardSetAside?.(join(strayHome, '.removing-looks-right'))
if (handedAside !== null) discardSetAside?.(handedAside)
check('the tree handed over is deleted, its read-only folder and its links with it', await gone(home), setAside(home).join(', '))
if (linkedOut) check('a link out of the tree was unlinked, never followed: the folder it named is whole', readFileSync(join(outside, 'keep.txt'), 'utf8') === 'outside the tree\n' && readFileSync(join(outside, 'sealed', 'inner.txt'), 'utf8') === 'outside and read-only\n')
if (linkedOut) check('…and keeps its modes', (statSync(join(outside, 'sealed')).mode & 0o7777) === outsideModeBefore, (statSync(join(outside, 'sealed')).mode & 0o7777).toString(8))
await wait(500)
check('a folder without the set-aside name is not deleted', existsSync(join(impostor, 'inside')))
check('a folder with the name but outside a worktrees home is not deleted', existsSync(join(strayHome, '.removing-looks-right', 'inside')))
rmSync(impostor, { recursive: true, force: true })

section('§5 a tree left set aside by a process that died is no worktree to anyone, and the janitor sweeps it')
const orphaned = await createAgentWorktree('agent-ab500001')
await unlockAgentWorktree(orphaned.worktreePath, repo)
const orphanAside = setWorktreeAside?.(orphaned.worktreePath) ?? null
git(repo, 'worktree', 'remove', orphaned.worktreePath)
const freshAside = join(home, `.removing-agent-ab500002-1-${Date.now().toString(36)}`)
mkdirSync(join(freshAside, 'node_modules'), { recursive: true })
check('git lists neither the path it had nor the tree set aside', orphanAside !== null && !registered(repo).some(path => path === orphaned.worktreePath || path.includes('.removing-')), registered(repo).join(' | '))
const leftovers = await crewLeftoverWorktrees(repo, Date.now())
check('the crew\'s list of leftover worktrees names neither', !leftovers.some(row => row.path === orphaned.worktreePath || row.path.includes('.removing-')), leftovers.map(row => row.path).join(' | '))
check('git status of the project is clean while both stand there', git(repo, 'status', '--porcelain') === '', git(repo, 'status', '--porcelain'))
const withinGrace = await cleanupStaleAgentWorktrees(hoursAgo(8 * 24))
check('inside its first hour the janitor leaves a set-aside tree to its own delete', orphanAside !== null && existsSync(orphanAside) && existsSync(freshAside), String(withinGrace))
if (orphanAside !== null) utimesSync(orphanAside, hoursAgo(2), hoursAgo(2))
const stale = await createAgentWorktree('agent-ab400001')
await unlockAgentWorktree(stale.worktreePath, repo)
utimesSync(stale.worktreePath, hoursAgo(9 * 24), hoursAgo(9 * 24))
const removedCount = await cleanupStaleAgentWorktrees(hoursAgo(8 * 24))
check('the janitor removes an old clean lane and its branch', !existsSync(stale.worktreePath) && git(repo, 'branch', '--list', 'worktree-agent-ab400001') === '' && removedCount >= 1, String(removedCount))
check('…and sweeps the tree whose delete died more than an hour ago', orphanAside !== null && (await (async () => {
  const until = Date.now() + 60_000
  while (existsSync(orphanAside) && Date.now() < until) await wait(100)
  return !existsSync(orphanAside)
})()), String(removedCount))
check('…while one set aside just now is left alone', existsSync(freshAside))
rmSync(freshAside, { recursive: true, force: true })
await gone(home)
check('the lanes made a moment ago are untouched', existsSync(noted.worktreePath) && existsSync(plain.worktreePath))

section('§6 a worktree that holds links is removed in place, as before')
process.env.MERCURY_WORKTREE_CLONE = 'off'
const linkedSession = await createWorktreeForSession('proof-session', 'leave-link')
delete process.env.MERCURY_WORKTREE_CLONE
await cleanupWorktree()
check('the path is gone and nothing was ever set aside', !existsSync(linkedSession.worktreePath) && setAside(home).length === 0, setAside(home).join(', '))
check('the checkout\'s own dependency folder is untouched by the removal', existsSync(join(repo, 'node_modules', 'pkg-0', 'lib', 'm0.js')))

section('§7 a read-only folder inside a clone does not keep the copy')
const sealed = await createWorktreeForSession('proof-session', 'leave-sealed')
if (cloneRoad && process.getuid?.() !== 0) {
  chmodSync(join(sealed.worktreePath, 'node_modules', 'pkg-1', 'lib'), 0o555)
  const sealedRefusal = await refusal(() => cleanupWorktree())
  check('the removal succeeds', sealedRefusal === '' && !existsSync(sealed.worktreePath), sealedRefusal)
  check('…and the tree set aside is deleted, the read-only folder with it', await gone(home), setAside(home).join(', '))
} else {
  skip('no clone here, or this user writes every folder: the link holds no folder of its own')
  await cleanupWorktree()
  check('the worktree is removed', !existsSync(sealed.worktreePath))
}

section('§8 the daemon reaps a worker\'s worktree the same way: a read-only folder in its clone, which a delete in place could not take, goes with it')
const daemonHome = join(scratch, 'daemon')
const workerHome = join(daemonHome, 'worktrees')
mkdirSync(daemonHome)
const worker = await ensureWorkerWorktree(repo, 'runner-clone', daemonHome)
check('the worker worktree is made', worker.ok === true, JSON.stringify(worker))
if (worker.ok) {
  const workerHoldsClone = lstatSync(join(worker.path, 'node_modules')).isDirectory() && !lstatSync(join(worker.path, 'node_modules')).isSymbolicLink()
  check(`…with its dependency folder its own where the volume clones${links ? '' : ', and where this account may not make the link'}`, workerHoldsClone === (cloneRoad || !links), String(workerHoldsClone))
  const diedInDaemon = join(workerHome, `.removing-runner-gone-1-${Date.now().toString(36)}`)
  mkdirSync(join(diedInDaemon, 'node_modules'), { recursive: true })
  utimesSync(diedInDaemon, hoursAgo(2), hoursAgo(2))
  const sealedInWorker = cloneRoad && process.getuid?.() !== 0
  if (sealedInWorker) chmodSync(join(worker.path, 'node_modules', 'pkg-1', 'lib'), 0o555)
  started = performance.now()
  const outcome = reapWorkerWorktree(repo, 'runner-clone', daemonHome)
  const reapedIn = performance.now() - started
  const asideInDaemon = setAside(workerHome).filter(name => name.startsWith('.removing-runner-clone-'))
  console.log(`  the reap returned in ${reapedIn.toFixed(0)} ms; still set aside at that moment: ${asideInDaemon.join(', ') || 'nothing (its delete had already finished)'}`)
  check('the reap answers reaped, the path is gone when it returns and git has dropped it', outcome.outcome === 'reaped' && !existsSync(worker.path) && !registered(repo).includes(worker.path), JSON.stringify(outcome))
  if (!sealedInWorker) skip('no clone here, or this user writes every folder: the worker worktree is removed in place, as before')
  if (!cloneRoad) check('with no clone nothing of the worker is set aside', asideInDaemon.length === 0)
  check('…and it and a tree whose delete died there earlier are deleted apart', await gone(workerHome), setAside(workerHome).join(', '))
}

enter(ROOT)
await gone(home)
chmodSync(join(outside, 'sealed'), 0o755)
if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
