#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { accountLinks, LINK_PRIVILEGE, runnableOnWindows } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const refusal = async (fn: () => unknown): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const state = await import('../../src/boot/process-state/processState.ts')
const config = await import('../../src/platform/config/globalConfig.ts')
const trust = await import('../../src/platform/config/trust.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const agentTool = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const { cleanupStaleAgentWorktrees, createAgentWorktree, readWorktreeDelta } = await import('../../src/platform/git/worktree/worktree.ts')
const { crewWorktreeLeftoverOf } = await import('../../src/crew/crewmates/crewWorktreeReminder.ts')
const { computeEnvInfo } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agent-cwd-')))
const links = accountLinks(scratch)
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const initRepo = (dir: string, files: Record<string, string>): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
}
const authoredStatus = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall').split('\n').filter(line => line !== '' && !line.slice(3).startsWith('.mercury/')).join('\n')
const isLinkTo = (path: string, target: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(target)
  } catch {
    return false
  }
}
const placedAs = (path: string, target: string): boolean => {
  if (links) return isLinkTo(path, target)
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
const excludeHolds = (lines: readonly string[], name: string): boolean => lines.filter(line => line === name).length === (links ? 1 : 0)

section('§1 the schema the model sees')
const schema = agentTool.inputSchema()
const shape = schema.shape as Record<string, { description?: string }>
check('the schema carries cwd', 'cwd' in shape, Object.keys(shape).join(',') + ' — add the cwd field to the Agent input schema in src/tools/crewmate/call/schema.ts')
const words = shape.cwd?.description ?? ''
check('…and its words name the trust bound and the worktree', words.includes('Starting outside the session\'s folder asks for permission') && words.includes('with isolation, its repository supplies the worktree'), words + ' — restore the cwd field description in src/tools/crewmate/call/schema.ts')
const parsed = schema.safeParse({ description: 'd', prompt: 'p', cwd: '/x' })
check('a cwd on the wire reaches the call', parsed.success && (parsed.data as { cwd?: string }).cwd === '/x', JSON.stringify(parsed.success ? parsed.data : parsed.error.issues) + ' — the Agent input schema in src/tools/crewmate/call/schema.ts must pass cwd through safeParse')

section('§2 the directory the helper works in: resolved, refused typed, bounded by trust')
const work = join(scratch, 'work')
const inside = join(work, 'lane')
const sibling = join(scratch, 'elsewhere')
const added = join(scratch, 'added')
mkdirSync(inside, { recursive: true })
mkdirSync(sibling)
mkdirSync(added)
writeFileSync(join(work, 'a-file'), 'x\n')
process.chdir(work)
state.setOriginalCwd(work)
state.setCwdState(work)
state.setIsInteractive(true)
config.enableConfigs()
const context = getEmptyToolPermissionContext()
const resolveCwd = (spelling: string, ctx = context): string => agentTool.resolveAgentCwd(spelling, ctx)
check('a relative spelling is refused as such', (await refusal(() => resolveCwd('lane'))).includes('must be an absolute directory'), 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must throw "cwd must be an absolute directory" for a relative path')
const missing = await refusal(() => resolveCwd(join(work, 'nowhere')))
check('a missing directory is refused typed, naming the session folder', missing.includes('cwd does not exist') && missing.includes(work), missing + ' — resolveAgentCwd in src/tools/crewmate/call/cwd.ts must throw "cwd does not exist" and name the session folder')
check('a file is refused as not a folder', (await refusal(() => resolveCwd(join(work, 'a-file')))).includes('cwd is not a folder'), 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must throw "cwd is not a folder" for a file')
check('a directory under the session folder is accepted, as its real path', resolveCwd(inside) === realpathSync(inside), 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must return the real path of a directory under the session folder')
const outside = await refusal(() => resolveCwd(sibling))
check('path resolution leaves folder consent to the ordinary permission check', outside === '' && resolveCwd(sibling) === sibling, outside + ' — resolveAgentCwd in src/tools/crewmate/call/cwd.ts must not refuse for folder consent; that is the ordinary permission check')
trust.setPathTrusted(sibling)
check('…and accepted once the operator trusted it', resolveCwd(sibling) === sibling, 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must return the directory after setPathTrusted (src/platform/config/trust.ts)')
check('another valid directory resolves without declaring another root', resolveCwd(added) === added, 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must resolve any valid directory without needing another declared root')
const repo = join(scratch, 'repo')
initRepo(repo, { 'a.txt': 'one\n' })
const repoLane = join(scratch, 'repo-lane')
git(repo, 'worktree', 'add', '-q', '-b', 'lane', repoLane)
check('a sibling worktree resolves for an ordinarily approved launch', resolveCwd(repoLane) === repoLane, 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must resolve a sibling git worktree of the session repository')
trust.setPathTrusted(repo)
check('…and accepted once its repository is trusted (the record is keyed by the canonical root)', resolveCwd(repoLane) === repoLane, 'resolveAgentCwd in src/tools/crewmate/call/cwd.ts must resolve the worktree once its repository is trusted via setPathTrusted (src/platform/config/trust.ts)')

section("§3 a worktree-isolated helper finds the parent checkout's dependencies and packs: the links of a volume that cannot clone (MERCURY_WORKTREE_CLONE=off; prove-worktree-clone.ts reads the clones)")
process.env.MERCURY_WORKTREE_CLONE = 'off'
const deps = join(scratch, 'deps')
initRepo(deps, {
  '.gitignore': 'node_modules/\nvendor/*/\n',
  'package.json': JSON.stringify({ name: 'deps-fixture', scripts: { typecheck: 'typecheck-fixture' } }),
  'vendor/pack-a.lock.json': '{}\n',
})
mkdirSync(join(deps, 'node_modules', '.bin'), { recursive: true })
writeFileSync(join(deps, 'node_modules', '.bin', 'typecheck-fixture'), '#!/bin/sh\nprintf typecheck-ok\n')
chmodSync(join(deps, 'node_modules', '.bin', 'typecheck-fixture'), 0o755)
runnableOnWindows(join(deps, 'node_modules', '.bin', 'typecheck-fixture'), 'typecheck-ok')
mkdirSync(join(deps, 'vendor', 'pack-a'))
writeFileSync(join(deps, 'vendor', 'pack-a', 'marker'), 'pack\n')
mkdirSync(join(deps, 'authored'))
writeFileSync(join(deps, 'authored', 'note'), 'not ignored\n')
const parentStatusBefore = authoredStatus(deps)
process.chdir(deps)
state.setOriginalCwd(deps)
state.setCwdState(deps)
const first = await createAgentWorktree('agent-a0000001')
if (!links) skip(`the links a copy is made of with no clone: ${LINK_PRIVILEGE}; the folders this account gets in their place are read instead`)
check(links ? "node_modules is a link to the parent checkout's" : 'node_modules is a folder of the copy, in place of the link', placedAs(join(first.worktreePath, 'node_modules'), join(deps, 'node_modules')), first.worktreePath + ' — createAgentWorktree in src/platform/git/worktree/worktree.ts must link (or copy, with no links) node_modules from the parent checkout')
check(links ? 'every vendored pack is a link too' : 'every vendored pack is a folder of the copy too', placedAs(join(first.worktreePath, 'vendor', 'pack-a'), join(deps, 'vendor', 'pack-a')), 'createAgentWorktree in src/platform/git/worktree/worktree.ts must place each ignored vendor pack of the parent checkout in the worktree')
check('an authored untracked directory of the parent is not linked', !existsSync(join(first.worktreePath, 'authored')), 'createAgentWorktree in src/platform/git/worktree/worktree.ts must place only ignored dependency folders, never an authored untracked directory')
const laneStatus = git(first.worktreePath, 'status', '--porcelain')
check('the links are hidden from git in the worktree', laneStatus === '', laneStatus + ' — createAgentWorktree in src/platform/git/worktree/worktree.ts must hide the placed links from git (the exclude file)')
check("the parent checkout's status is unchanged", authoredStatus(deps) === parentStatusBefore, authoredStatus(deps) + ' — createAgentWorktree in src/platform/git/worktree/worktree.ts must leave the parent checkout status unchanged')
const excludePath = join(deps, '.git', 'info', 'exclude')
const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
const excludeLines = exclude.split('\n')
check(links ? "the clone's exclude file carries the link names, anchored, once each" : "the clone's exclude file gains no line: the ignore rules the checkout tracks hide a folder", excludeHolds(excludeLines, '/node_modules') && excludeHolds(excludeLines, '/vendor/pack-a'), exclude + ' — createAgentWorktree in src/platform/git/worktree/worktree.ts must write each anchored link name once to the git info/exclude file')
const delta = await readWorktreeDelta(first.worktreePath, first.headCommit)
check('the settlement reads no authored work', delta.untrackedAuthored.length === 0 && delta.tracked.length === 0 && delta.uncertainty === null, JSON.stringify(delta) + ' — readWorktreeDelta in src/platform/git/worktree/delta.ts must not count placed links as authored work')
let typecheck = ''
try {
  typecheck = execFileSync(process.execPath, ['run', 'typecheck'], { cwd: first.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  typecheck = `failed: ${String((error as { stderr?: string }).stderr ?? error)}`
}
check('bun run typecheck exits 0 in the worktree', typecheck.includes('typecheck-ok'), typecheck.slice(0, 200) + ' — the worktree from createAgentWorktree (src/platform/git/worktree/worktree.ts) must hold node_modules so its package script runs')
const second = await createAgentWorktree('agent-a0000002', { from: deps })
const excludeAgain = readFileSync(excludePath, 'utf8').split('\n')
check(links ? 'a second worktree adds no duplicate exclude line' : 'a second worktree adds no exclude line either', excludeHolds(excludeAgain, '/node_modules'), 'createAgentWorktree in src/platform/git/worktree/worktree.ts must not add a duplicate line to info/exclude for a second worktree')
check(links ? '…and is linked the same way' : '…and holds its folder the same way', placedAs(join(second.worktreePath, 'node_modules'), join(deps, 'node_modules')), 'createAgentWorktree in src/platform/git/worktree/worktree.ts must place node_modules in every worktree it makes')
const DAY = 86_400_000
const leftOf = (lane: { worktreePath: string; worktreeBranch?: string; gitRoot?: string }) =>
  crewWorktreeLeftoverOf({ name: 'mate', path: lane.worktreePath, branch: lane.worktreeBranch, gitRoot: lane.gitRoot }, Date.now())
const janitor = (repo: string, ...lanes: string[]): Promise<number> => {
  const old = new Date(Date.now() - 9 * DAY)
  for (const lane of lanes) utimesSync(lane, old, old)
  return runWithCwdOverride(repo, () => cleanupStaleAgentWorktrees(new Date(Date.now() - 8 * DAY)))
}
const leftFirst = await leftOf(first)
const leftSecond = await leftOf(second)
const takenLinks = await janitor(deps, first.worktreePath, second.worktreePath)
check('a worktree holding only links settles (removed)', leftFirst.state === 'clean' && !existsSync(first.worktreePath), JSON.stringify({ leftFirst, takenLinks }) + ' — crewWorktreeLeftoverOf (src/crew/crewmates/crewWorktreeReminder.ts) and cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must treat a worktree holding only links as clean and remove it')
check('…both of them', leftSecond.state === 'clean' && takenLinks === 2 && !existsSync(second.worktreePath), JSON.stringify({ leftSecond, takenLinks }) + ' — cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must remove both link-only worktrees')
const other = join(scratch, 'other')
initRepo(other, { 'b.txt': 'two\n', '.gitignore': 'node_modules/\n' })
mkdirSync(join(other, 'node_modules'))
writeFileSync(join(other, 'node_modules', 'marker'), 'x\n')
const nested = join(other, 'src')
mkdirSync(nested)
const third = await createAgentWorktree('agent-a0000003', { from: nested })
check("with a directory named, the worktree is cut from that directory's repository, not the session's", third.gitRoot === other && existsSync(join(third.worktreePath, 'b.txt')) && !existsSync(join(third.worktreePath, 'package.json')), `${third.gitRoot} · ${third.worktreePath}` + ' — createAgentWorktree in src/platform/git/worktree/worktree.ts must cut from the repository of the `from` directory')
check(links ? '…with its dependencies linked from that checkout' : '…with its dependencies copied from that checkout', placedAs(join(third.worktreePath, 'node_modules'), join(other, 'node_modules')) && readFileSync(join(third.worktreePath, 'node_modules', 'marker'), 'utf8') === 'x\n', 'createAgentWorktree in src/platform/git/worktree/worktree.ts must place dependencies from the checkout named by `from`')
const leftThird = await leftOf(third)
const takenThird = await janitor(other, third.worktreePath)
check('…and it settles too', leftThird.state === 'clean' && takenThird === 1 && !existsSync(third.worktreePath), JSON.stringify({ leftThird, takenThird }) + ' — cleanupStaleAgentWorktrees (src/platform/git/worktree/worktree.ts) must settle a worktree cut from another repository')
delete process.env.MERCURY_WORKTREE_CLONE

const model = 'claude-fable-5-1'
const plainBlock = await computeEnvInfo(model)
check('with no override the env block names the boot directory', plainBlock.includes(`Working directory: ${state.getOriginalCwd()}\n`), plainBlock.split('\n').slice(0, 4).join(' | ') + ' — computeEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts must print the boot directory as Working directory')
const overriddenBlock = await runWithCwdOverride(inside, () => computeEnvInfo(model))
check('under a cwd override the env block names the override', overriddenBlock.includes(`Working directory: ${inside}\n`) && !overriddenBlock.includes(`Working directory: ${deps}\n`), overriddenBlock.split('\n').slice(0, 4).join(' | ') + ' — computeEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts must print the runWithCwdOverride directory as Working directory')
check('…and nothing else in the block moved', plainBlock.replace(`Working directory: ${state.getOriginalCwd()}\n`, '') === overriddenBlock.replace(`Working directory: ${inside}\n`, ''), 'computeEnvInfo in src/engine/system-prompt/defaultSystemPrompt.ts must change only the Working directory line under a cwd override')

process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
