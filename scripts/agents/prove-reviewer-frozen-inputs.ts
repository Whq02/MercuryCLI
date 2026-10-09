#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')
const { MERCURY_CREW_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryCrewAgent.ts')
const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryScoutAgent.ts')
const { REVIEW_BRIEF } = await import('../../src/tools/AgentTool/reviewerPolicy.ts')
const { renderAgentLine } = await import('../../src/cli/handlers/agents.ts')
const { buildFrozenWorktreeNotice } = await import('../../src/tools/AgentTool/frozenWorktreeNotice.ts')

section('§1 two built-ins; the review is a launch option, not a type')
const roster = getBuiltInAgents()
check('the built-in roster is mercury-crew then mercury-scout, nothing else', roster.map(a => a.agentType).join(',') === 'mercury-crew,mercury-scout', roster.map(a => a.agentType).join(', '))
check('mercury-crew carries every tool and inherits the session model by default', JSON.stringify(MERCURY_CREW_AGENT.tools) === '["*"]' && MERCURY_CREW_AGENT.disallowedTools === undefined && MERCURY_CREW_AGENT.model === undefined)
const scoutDenied = new Set(MERCURY_SCOUT_AGENT.disallowedTools ?? [])
check('mercury-scout has no writer and no agent spawn', ['Edit', 'Write', 'NotebookEdit', 'Agent'].every(t => scoutDenied.has(t)) && MERCURY_SCOUT_AGENT.fixedOutputContract === true, [...scoutDenied].join(','))
check('no built-in isolates in a worktree by definition or carries a review contract', roster.every(a => a.isolation === undefined && !/REVIEW: CLEAN/.test(a.whenToUse)))
check("the review brief opens on the reviewer's charge and names the frozen inputs", REVIEW_BRIEF.startsWith('You are reviewing one committed change for Mercury, on frozen inputs.') && REVIEW_BRIEF.includes('detached at that commit'))
check('the brief names the one write and the closing line', REVIEW_BRIEF.includes('section: "## Review"') && REVIEW_BRIEF.includes('REVIEW: CLEAN') && REVIEW_BRIEF.includes('REVIEW: FINDINGS <count>'))
const runAgent = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
check('the brief rides the system prompt of every launch that declares a receipt', runAgent.includes('if (reviewReceipt !== undefined) systemPrompt.push(REVIEW_BRIEF,'))
check('a receipt without a frozen worktree refuses before the run', runAgent.includes("throw new Error('review_receipt requires a frozen worktree: launch the review with isolation worktree and worktree_at')"))
check('the receipt is keyed on the launch, not on an agent type', !/const reviewReceipt = agentDefinition\.agentType ===/.test(runAgent) && runAgent.includes('const reviewReceipt = requestedReviewReceipt === undefined'))
for (const definition of roster) check(`the agents inventory renders ${definition.agentType}`, renderAgentLine({ definition, shadowedBy: undefined }).startsWith(definition.agentType))

section('§2 the frozen worktree on a real repository')
const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { createAgentWorktree, settleAgentWorktree } = await import('../../src/utils/worktree.ts')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-frozen-')))
const repo = join(scratch, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const g = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim()
writeFileSync(join(repo, 'a.txt'), 'one\n')
g('add', 'a.txt')
g('commit', '-q', '-m', 'first')
const first = g('rev-parse', 'HEAD')
writeFileSync(join(repo, 'a.txt'), 'two\n')
g('commit', '-q', '-am', 'second')
const second = g('rev-parse', 'HEAD')
process.chdir(repo)
state.setOriginalCwd(repo)
state.setCwdState(repo)
state.setIsInteractive(true)
config.enableConfigs()

const frozen = await createAgentWorktree('agent-frozen01', { at: first })
check('the worktree stands at the named commit', existsSync(frozen.worktreePath) && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: frozen.worktreePath, encoding: 'utf8' }).trim() === first)
check('…detached (no branch)', (() => {
  try {
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: frozen.worktreePath, stdio: 'pipe' })
    return false
  } catch {
    return true
  }
})() && frozen.worktreeBranch === undefined && frozen.headCommit === first)
check('…reading the tree of that commit', readFileSync(join(frozen.worktreePath, 'a.txt'), 'utf8') === 'one\n')
writeFileSync(join(repo, 'a.txt'), 'three\n')
g('commit', '-q', '-am', 'third')
check('a later commit on the branch does not move it', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: frozen.worktreePath, encoding: 'utf8' }).trim() === first && readFileSync(join(frozen.worktreePath, 'a.txt'), 'utf8') === 'one\n')
check('no branch was made for it', !g('branch', '--list').includes('frozen01'))
let refused = ''
try {
  await createAgentWorktree('agent-frozen02', { at: 'no-such-ref-anywhere' })
} catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
check('a spelling that resolves to no commit refuses before anything is created', refused.includes('does not resolve to a commit') && !g('worktree', 'list').includes('frozen02'), refused)
refused = ''
try {
  await createAgentWorktree('agent-frozen03', { at: 'main; rm -rf /' })
} catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
check('a hostile spelling refuses as not a commit spelling', refused.includes('is not a commit spelling'), refused)
refused = ''
try {
  await createAgentWorktree('agent-frozen01', { at: second })
} catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
check('the same slug at another commit refuses (a frozen tree is never silently moved)', refused.includes('already exists at'), refused)
const again = await createAgentWorktree('agent-frozen01', { at: first })
check('the same slug at the same commit resumes it', again.existed !== false && again.worktreePath === frozen.worktreePath && again.headCommit === first)
const settled = await settleAgentWorktree({ ...frozen })
check('a clean frozen worktree settles (removed)', settled.outcome === 'settled' && !existsSync(frozen.worktreePath), JSON.stringify(settled))
process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)

section('§3 the Agent tool')
const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
check('the schema carries worktree_at beside isolation', /worktree_at: z\s*\.string\(\)\s*\.optional\(\)/.test(agentTool))
check('the pin reaches the worktree owner', agentTool.includes("input.worktree_at !== undefined ? { at: input.worktree_at } : undefined"))
check('the pin without isolation is refused at the call', agentTool.includes("throw new Error(\"worktree_at needs isolation: 'worktree'"))
const notice = buildFrozenWorktreeNotice('/w/agent-1', first)
check('the frozen notice names the path and the commit', notice.includes('/w/agent-1') && notice.includes(first) && notice.includes('frozen'))

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
