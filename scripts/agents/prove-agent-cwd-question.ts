#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const refusal = (fn: () => unknown): string => {
  try {
    fn()
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
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
type PermissionContext = ReturnType<typeof getEmptyToolPermissionContext>
type ToolContext = Parameters<typeof decideToolPermission>[2]

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agent-cwd-question-')))
const work = join(scratch, 'work')
const lane = join(work, 'lane')
const elsewhere = join(scratch, 'elsewhere')
const another = join(scratch, 'another')
const trusted = join(scratch, 'trusted')
for (const dir of [lane, elsewhere, another, trusted]) mkdirSync(dir, { recursive: true })
process.chdir(work)
state.setOriginalCwd(work)
state.setCwdState(work)
state.setIsInteractive(true)
config.enableConfigs()
trust.setPathTrusted(trusted)
const context = getEmptyToolPermissionContext()
const seat = (mode: string): ToolContext =>
  ({
    getAppState: () => ({ toolPermissionContext: { ...context, mode } as PermissionContext }),
    abortController: new AbortController(),
    agentType: undefined,
    options: {},
  }) as unknown as ToolContext
const launch = (cwd: string): Record<string, unknown> => ({ description: 'probe', prompt: 'say where you are', cwd })

section('§1 a folder outside every trusted workspace is a question, with the folder named')
const question = agentTool.agentCwdQuestion(elsewhere, context)
check('the question is an ask', question?.behavior === 'ask', JSON.stringify(question))
check('its words are the existing write-scope sentence', (question?.message ?? '').includes(`cwd ${elsewhere} is outside every workspace this session trusts`) && (question?.message ?? '').includes("The session's write scope is"), question?.message)
check('the card line names the folder as a working-directory question', question?.decisionReason?.type === 'workingDir' && (question.decisionReason as { reason: string }).reason.includes(elsewhere), JSON.stringify(question?.decisionReason))
check('the suggestion offered is the folder as a session working directory', JSON.stringify(question?.suggestions) === JSON.stringify([{ type: 'addDirectories', directories: [elsewhere], destination: 'session' }]), JSON.stringify(question?.suggestions))
check('a folder under the session directory is no question', agentTool.agentCwdQuestion(lane, context) === null)
check('a folder the operator trusted is no question', agentTool.agentCwdQuestion(trusted, context) === null)
check('a missing folder is no question (the launch refuses it typed)', agentTool.agentCwdQuestion(join(work, 'nowhere'), context) === null)
check('a relative spelling is no question (the launch refuses it typed)', agentTool.agentCwdQuestion('lane', context) === null)

section('§2 the three answers')
const asked = await decideToolPermission(agentTool.AgentTool, launch(elsewhere), seat('default'))
check('in a mode that asks, the engine asks with the folder named', asked.decision.behavior === 'ask' && asked.trace.decidedBy === 'resolution' && JSON.stringify(asked.decision).includes(elsewhere), `${asked.decision.behavior} by ${asked.trace.decidedBy}`)
const sovereign = await decideToolPermission(agentTool.AgentTool, launch(elsewhere), seat('sovereign'))
check('in sovereign the question answers itself yes, at the posture band', sovereign.decision.behavior === 'allow' && sovereign.trace.decidedBy === 'bypassPosture', `${sovereign.decision.behavior} by ${sovereign.trace.decidedBy}`)
const refused = refusal(() => agentTool.resolveAgentCwd(elsewhere, context))
check('a launch the question never admitted is refused with the existing sentence', refused.includes('outside every workspace this session trusts') && refused.includes("The session's write scope is"), refused)
check('…and the folder is still a question afterwards (a no leaves no memory)', agentTool.agentCwdQuestion(elsewhere, context) !== null)
check('the launch that follows a yes admits the folder', agentTool.resolveAgentCwd(elsewhere, context, { admit: true }) === elsewhere)
check('the same folder is no question for the rest of the session', agentTool.agentCwdQuestion(elsewhere, context) === null)
const again = await decideToolPermission(agentTool.AgentTool, launch(elsewhere), seat('default'))
check('…and the engine allows the next launch there without a card', again.decision.behavior === 'allow', `${again.decision.behavior} by ${again.trace.decidedBy}`)
check('…and the resolver accepts it without the admission', agentTool.resolveAgentCwd(elsewhere, context) === elsewhere)
check('a different folder is still a question', agentTool.agentCwdQuestion(another, context) !== null)
const teammate = await agentTool.AgentTool.checkPermissions({ ...launch(another), team_name: 'crew', name: 'mate' }, seat('default'))
check('a named teammate spawn asks no question (the launch refuses cwd typed)', teammate.behavior === 'allow')
const teammateContext = await import('../../src/utils/teammate.ts')
teammateContext.setDynamicTeamContext({ agentId: '', agentName: '', teamName: 'crew', planModeRequired: false })
try {
  const named = await agentTool.AgentTool.checkPermissions({ ...launch(another), name: 'mate' }, seat('default'))
  check('a name-only teammate launch uses the same team resolution before asking', named.behavior === 'allow')
} finally {
  teammateContext.clearDynamicTeamContext()
}
const trustedLaunch = await decideToolPermission(agentTool.AgentTool, launch(trusted), seat('default'))
check('a trusted folder launches with no question in a mode that asks', trustedLaunch.decision.behavior === 'allow', `${trustedLaunch.decision.behavior} by ${trustedLaunch.trace.decidedBy}`)

section('§3 the launch and the words')
const source = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
check('the permission check asks the question', source.includes('agentCwdQuestion(input.cwd, context.getAppState().toolPermissionContext)'))
check('the launch admits the folder once it is reached', source.includes("resolveAgentCwd(input.cwd, context.getAppState().toolPermissionContext, { admit: true })"))
const words = (agentTool.inputSchema().shape as Record<string, { description?: string }>).cwd?.description ?? ''
check('the parameter words tell the model about the question', words.includes('permission question') && words.includes('once per folder per session') && words.includes('trusts') && words.includes("isolation 'worktree'"), words)
const teamsDoc = readFileSync(join(ROOT, 'docs/TEAMS.md'), 'utf8').replace(/\s+/g, ' ')
check('the teams page describes the question', teamsDoc.includes('permission question to the operator') && teamsDoc.includes('once per folder per session'))

process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
