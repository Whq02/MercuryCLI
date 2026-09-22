#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
const refusal = async (fn: () => unknown): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const trust = await import('../../src/utils/config/trust.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const agentTool = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { createAgentWorktree, readWorktreeDelta, settleAgentWorktree } = await import('../../src/utils/worktree.ts')
const { computeEnvInfo } = await import('../../src/constants/prompts.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agent-cwd-')))
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

section('§1 the schema the model sees')
const schema = agentTool.inputSchema()
const shape = schema.shape as Record<string, { description?: string }>
check('the schema carries cwd', 'cwd' in shape, Object.keys(shape).join(','))
const words = shape.cwd?.description ?? ''
check('…and its words name the trust bound and the worktree', words.includes('trusts') && words.includes("isolation 'worktree'"), words)
const parsed = schema.safeParse({ description: 'd', prompt: 'p', cwd: '/x' })
check('a cwd on the wire reaches the call', parsed.success && (parsed.data as { cwd?: string }).cwd === '/x', JSON.stringify(parsed.success ? parsed.data : parsed.error.issues))

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
check('a relative spelling is refused as such', (await refusal(() => resolveCwd('lane'))).includes('must be an absolute directory'))
const missing = await refusal(() => resolveCwd(join(work, 'nowhere')))
check('a missing directory is refused typed, naming the session folder', missing.includes('cwd does not exist') && missing.includes(work), missing)
check('a file is refused as not a folder', (await refusal(() => resolveCwd(join(work, 'a-file')))).includes('cwd is not a folder'))
check('a directory under the session folder is accepted, as its real path', resolveCwd(inside) === realpathSync(inside))
const outside = await refusal(() => resolveCwd(sibling))
check('a directory outside every trusted workspace is refused with the write-scope sentence', outside.includes('outside every workspace this session trusts') && outside.includes("The session's write scope is") && outside.includes(work), outside)
trust.setPathTrusted(sibling)
check('…and accepted once the operator trusted it', resolveCwd(sibling) === sibling)
const widened = { ...context, additionalWorkingDirectories: new Map([[added, { source: 'cliArg' }]]) } as typeof context
check('a directory the session added as a working directory is accepted', resolveCwd(added, widened) === added)
const repo = join(scratch, 'repo')
initRepo(repo, { 'a.txt': 'one\n' })
const repoLane = join(scratch, 'repo-lane')
git(repo, 'worktree', 'add', '-q', '-b', 'lane', repoLane)
check('a linked worktree of an untrusted repository is refused', (await refusal(() => resolveCwd(repoLane))).includes('outside every workspace'))
trust.setPathTrusted(repo)
check('…and accepted once its repository is trusted (the record is keyed by the canonical root)', resolveCwd(repoLane) === repoLane)

section("§3 a worktree-isolated helper finds the parent checkout's dependencies and packs")
const deps = join(scratch, 'deps')
initRepo(deps, {
  '.gitignore': 'node_modules/\nvendor/*/\n',
  'package.json': JSON.stringify({ name: 'deps-fixture', scripts: { typecheck: 'typecheck-fixture' } }),
  'vendor/pack-a.lock.json': '{}\n',
})
mkdirSync(join(deps, 'node_modules', '.bin'), { recursive: true })
writeFileSync(join(deps, 'node_modules', '.bin', 'typecheck-fixture'), '#!/bin/sh\nprintf typecheck-ok\n')
chmodSync(join(deps, 'node_modules', '.bin', 'typecheck-fixture'), 0o755)
mkdirSync(join(deps, 'vendor', 'pack-a'))
writeFileSync(join(deps, 'vendor', 'pack-a', 'marker'), 'pack\n')
mkdirSync(join(deps, 'authored'))
writeFileSync(join(deps, 'authored', 'note'), 'not ignored\n')
const parentStatusBefore = authoredStatus(deps)
process.chdir(deps)
state.setOriginalCwd(deps)
state.setCwdState(deps)
const first = await createAgentWorktree('agent-links001')
check("node_modules is a link to the parent checkout's", isLinkTo(join(first.worktreePath, 'node_modules'), join(deps, 'node_modules')), first.worktreePath)
check('every vendored pack is a link too', isLinkTo(join(first.worktreePath, 'vendor', 'pack-a'), join(deps, 'vendor', 'pack-a')))
check('an authored untracked directory of the parent is not linked', !existsSync(join(first.worktreePath, 'authored')))
const laneStatus = git(first.worktreePath, 'status', '--porcelain')
check('the links are hidden from git in the worktree', laneStatus === '', laneStatus)
check("the parent checkout's status is unchanged", authoredStatus(deps) === parentStatusBefore, authoredStatus(deps))
const excludePath = join(deps, '.git', 'info', 'exclude')
const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
const excludeLines = exclude.split('\n')
check("the clone's exclude file carries the link names, anchored, once each", excludeLines.filter(l => l === '/node_modules').length === 1 && excludeLines.filter(l => l === '/vendor/pack-a').length === 1, exclude)
const delta = await readWorktreeDelta(first.worktreePath, first.headCommit)
check('the settlement reads no authored work', delta.untrackedAuthored.length === 0 && delta.tracked.length === 0 && delta.uncertainty === null, JSON.stringify(delta))
let typecheck = ''
try {
  typecheck = execFileSync(process.execPath, ['run', 'typecheck'], { cwd: first.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  typecheck = `failed: ${String((error as { stderr?: string }).stderr ?? error)}`
}
check('bun run typecheck exits 0 in the worktree', typecheck.includes('typecheck-ok'), typecheck.slice(0, 200))
const second = await createAgentWorktree('agent-links002', { from: deps })
const excludeAgain = readFileSync(excludePath, 'utf8').split('\n')
check('a second worktree adds no duplicate exclude line', excludeAgain.filter(l => l === '/node_modules').length === 1)
check('…and is linked the same way', isLinkTo(join(second.worktreePath, 'node_modules'), join(deps, 'node_modules')))
const settledFirst = await settleAgentWorktree({ ...first })
check('a worktree holding only links settles (removed)', settledFirst.outcome === 'settled' && !existsSync(first.worktreePath), JSON.stringify(settledFirst))
const settledSecond = await settleAgentWorktree({ ...second })
check('…both of them', settledSecond.outcome === 'settled', JSON.stringify(settledSecond))
const other = join(scratch, 'other')
initRepo(other, { 'b.txt': 'two\n', '.gitignore': 'node_modules/\n' })
mkdirSync(join(other, 'node_modules'))
writeFileSync(join(other, 'node_modules', 'marker'), 'x\n')
const nested = join(other, 'src')
mkdirSync(nested)
const third = await createAgentWorktree('agent-links003', { from: nested })
check("with a directory named, the worktree is cut from that directory's repository, not the session's", third.gitRoot === other && existsSync(join(third.worktreePath, 'b.txt')) && !existsSync(join(third.worktreePath, 'package.json')), `${third.gitRoot} · ${third.worktreePath}`)
check('…with its dependencies linked from that checkout', isLinkTo(join(third.worktreePath, 'node_modules'), join(other, 'node_modules')))
const settledThird = await settleAgentWorktree({ ...third })
check('…and it settles too', settledThird.outcome === 'settled', JSON.stringify(settledThird))

section('§4 the launch and the prompt')
const source = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
check('the launch resolves cwd before any spawn', source.includes('resolveAgentCwd(input.cwd, context.getAppState().toolPermissionContext, { admit: true })'))
check('a named teammate spawn refuses cwd typed', source.includes('cwd applies to a sub-agent launch'))
check('the worktree preflight and the cut read the named directory', source.includes('preflightWorktreeCapability(cwdParam)') && source.includes('from: cwdParam'))
check('the helper runs in the worktree when both are named', source.includes('worktreeInfo?.worktreePath ?? cwdParam'))
check("the session-only home-folder trust arm reads the slot the boot's trust check reads", source.includes('getSessionTrustAccepted() && pathInWorkingPath(dir, homedir())'))
const model = 'claude-fable-5-1'
const plainBlock = await computeEnvInfo(model)
check('with no override the env block names the boot directory', plainBlock.includes(`Working directory: ${state.getOriginalCwd()}\n`), plainBlock.split('\n').slice(0, 4).join(' | '))
const overriddenBlock = await runWithCwdOverride(inside, () => computeEnvInfo(model))
check('under a cwd override the env block names the override', overriddenBlock.includes(`Working directory: ${inside}\n`) && !overriddenBlock.includes(`Working directory: ${deps}\n`), overriddenBlock.split('\n').slice(0, 4).join(' | '))
check('…and nothing else in the block moved', plainBlock.replace(`Working directory: ${state.getOriginalCwd()}\n`, '') === overriddenBlock.replace(`Working directory: ${inside}\n`, ''))

process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
