#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL']) delete process.env[k]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: 'true', args: [], connect: 'stdio' } })

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, jev: { ...(config.jev ?? {}), enabled: true, subagents: true } }))
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const toolsConstants = (await import('../../src/constants/tools.ts')) as Record<string, unknown>
const { filterToolsForAgent, resolveWorkerTools, resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { MERCURY_CREW_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryCrewAgent.ts')
const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryScoutAgent.ts')
const { restrictScoutTools, SCOUT_TOOLS_DESCRIPTION } = await import('../../src/tools/AgentTool/scoutPolicy.ts')
const { getAllBaseTools, assembleToolPool } = await import('../../src/tools.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { JevEvalTool } = await import('../../src/tools/JevEvalTool/JevEvalTool.ts')
const { AskAdvisorTool } = await import('../../src/tools/AskAdvisorTool/AskAdvisorTool.ts')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.ts')
const { ContractTool } = await import('../../src/tools/ContractTool/ContractTool.ts')
const { JournalTool } = await import('../../src/tools/JournalTool/JournalTool.ts')
const { LSP_TOOLS } = await import('../../src/tools/LSPTool/LSPTool.ts')
const { EnterWorktreeTool } = await import('../../src/tools/EnterWorktreeTool/EnterWorktreeTool.ts')
const { ExitWorktreeTool } = await import('../../src/tools/ExitWorktreeTool/ExitWorktreeTool.ts')
const { TaskCreateTool } = await import('../../src/tools/TaskCreateTool/TaskCreateTool.ts')
const { TaskGetTool } = await import('../../src/tools/TaskGetTool/TaskGetTool.ts')
const { TaskUpdateTool } = await import('../../src/tools/TaskUpdateTool/TaskUpdateTool.ts')
const { TaskListTool } = await import('../../src/tools/TaskListTool/TaskListTool.ts')
type Tool = import('../../src/Tool.ts').Tool

console.log("crewmate-toolbox: a crewmate's toolbox is the main seat's minus the BARRED set, foreground and background alike (the owner's ruling, 2026-10-16)")
const names = (list: readonly { name: string }[]): string[] => list.map(t => t.name).sort()
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((n, i) => n === b[i])

const catalogue: Tool[] = [...getAllBaseTools()]
for (const tool of [ComputerTool, JevEvalTool, AskAdvisorTool, DebugTool, EvalTool, ContractTool, JournalTool, ...LSP_TOOLS, EnterWorktreeTool, ExitWorktreeTool, TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] as Tool[]) {
  if (!catalogue.some(t => t.name === tool.name)) catalogue.push(tool)
}
const catalogueNames = names(catalogue)
console.log(`  the catalogue under proof: ${catalogue.length} tools`)

section('§1 THE BARRED SET, exactly — one row per tool with its reason word')
const BARRED: Record<string, string> = {
  AskUserQuestion: 'present human',
  ApolloReview: 'present human',
  AskAdvisor: 'present human',
  Computer: 'past its own work',
  Journal: 'past its own work',
  Workflow: 'past its own work',
  CronCreate: 'past its own work',
  CronDelete: 'past its own work',
  ScheduleWakeup: 'past its own work',
  RecordConvention: 'past its own work',
  Crewmate: 'recursion',
}
const table = (toolsConstants.CREWMATE_BARRED_TOOLS ?? {}) as Record<string, string>
const barred = toolsConstants.ALL_AGENT_DISALLOWED_TOOLS as Set<string>
for (const [name, reason] of Object.entries(BARRED)) {
  check(`${name} is barred — ${reason}`, barred.has(name) && table[name] === reason, `table says ${JSON.stringify(table[name])}`)
}
check('the barred set is exactly these eleven', same([...barred].sort(), Object.keys(BARRED).sort()), [...barred].sort().join(','))
check('custom definitions bar the same set (one deny set)', toolsConstants.CUSTOM_AGENT_DISALLOWED_TOOLS === barred)
check('TaskStop is exposed with a runtime ownership check', !barred.has('TaskStop') && src('src/tools/TaskStopTool/TaskStopTool.ts').includes('task.agentId === context.agentId'))
for (const name of Object.keys(BARRED)) {
  check(`${name} exists in the catalogue (a barred row names a real tool)`, catalogueNames.includes(name))
}

section('§2 THE ASYNC DOOR IS GONE — one filter, no allow-list, no retired spelling')
{
  const constants = src('src/constants/tools.ts')
  const utils = src('src/tools/AgentTool/agentToolUtils.ts')
  const filter = utils.slice(utils.indexOf('export function filterToolsForAgent('), utils.indexOf('export type ResolvedAgentTools'))
  check('the reach table carries no background class and no async allow-set', !constants.includes("'background'") && !constants.includes('ASYNC_AGENT_ALLOWED_TOOLS') && !constants.includes('AgentReach'))
  check('filterToolsForAgent has no isAsync door', !filter.includes('isAsync') && !filter.includes('ASYNC_AGENT_ALLOWED_TOOLS'), filter.replace(/\s+/g, ' ').slice(0, 300))
  check('the launch seam hands the derivation no async flag', !/resolveWorkerTools\([\s\S]{0,400}?shouldRunAsync/.test(src('src/tools/AgentTool/AgentTool.tsx').slice(src('src/tools/AgentTool/AgentTool.tsx').indexOf('const workerTools'))))
  check('the resume seam hands the derivation no async flag', !/resolveWorkerTools\([\s\S]{0,300}?(isAsync|true|false)\s*,?\s*\)/.test(src('src/tools/AgentTool/resumeAgent.ts')))
  const retired = ['src', 'docs'].flatMap(dir => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    try {
      return execFileSync('grep', ['-rl', 'ASYNC_AGENT_ALLOWED_TOOLS', join(ROOT, dir)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  })
  check('the retired spelling ASYNC_AGENT_ALLOWED_TOOLS exists nowhere under src/ or docs/', retired.length === 0, retired.join(', '))
}

section('§3 A CREWMATE\'S POOL = the catalogue minus barred — every tool named, foreground and background one derivation')
const crewPool = resolveWorkerTools(MERCURY_CREW_AGENT, 'default', catalogue)
const crewNames = names(crewPool)
const expected = catalogueNames.filter(n => !barred.has(n))
check('mercury-crew (tools: *) resolves to the catalogue minus the barred set, exactly', same(crewNames, expected), `missing: ${expected.filter(n => !crewNames.includes(n)).join(',')} · extra: ${crewNames.filter(n => !expected.includes(n)).join(',')}`)
const NEWLY_REACHABLE = ['Eval', 'Test', 'Debug', 'Launch', 'Service', 'Monitor', 'Browser', 'Journey', 'Git', 'Transaction', 'Structure', 'AstSearch', 'AstEdit', 'ChangeSet', 'LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest', 'Inspect', 'Checkpoint', 'Rewind', 'Contract', 'CronList', 'JevEval']
for (const name of NEWLY_REACHABLE) {
  check(`a crewmate carries ${name}`, crewNames.includes(name))
}
const KEPT = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ProviderSearch', 'Skill', 'ToolSearch', 'Sleep', 'ContextLeft', 'SendMessage', 'ResumeCrewmate', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'Retain', 'Recall', 'Reflect', 'Correct']
check('every tool a crewmate had before stays', KEPT.every(n => crewNames.includes(n)), KEPT.filter(n => !crewNames.includes(n)).join(','))
const filtered = names(filterToolsForAgent({ tools: catalogue, isBuiltIn: true }))
check('the filter alone gives the same set (the definition adds no narrowing for tools: *)', same(filtered, expected))
const custom = names(filterToolsForAgent({ tools: catalogue, isBuiltIn: false }))
check('a custom definition sees the same pool before its own tools: list narrows it', same(custom, expected))

section('§4 MCP TOOLS PASS')
{
  const mcp = [{ name: 'mcp__fixture__lookup' }, { name: 'mcp__fixture__store' }] as unknown as Tool[]
  const kept = names(filterToolsForAgent({ tools: [...catalogue, ...mcp], isBuiltIn: true }))
  check('both fixture MCP tools ride to a crewmate', kept.includes('mcp__fixture__lookup') && kept.includes('mcp__fixture__store'))
}

section('§5 THE SCOUT\'S READ-ONLY FORM holds — no Eval, no Test, no editors, no messaging')
{
  const scoutPool = restrictScoutTools(resolveWorkerTools(MERCURY_SCOUT_AGENT, 'default', catalogue))
  const scout = names(scoutPool)
  for (const name of ['Read', 'Glob', 'Grep', 'Bash', 'Inspect', 'Git', 'Structure', 'AstSearch', 'ChangeSet', 'CronList', 'WebFetch', 'Skill']) {
    check(`the scout keeps ${name} (its reading form)`, scout.includes(name))
  }
  for (const name of ['Eval', 'Test', 'Edit', 'Write', 'NotebookEdit', 'Browser', 'Launch', 'Transaction', 'Monitor', 'Crewmate', 'SendMessage', 'ResumeCrewmate', 'EnterWorktree', 'ExitWorktree', 'Retain', 'Correct', ...Object.keys(BARRED)]) {
    check(`the scout never carries ${name}`, !scout.includes(name))
  }
  check('the scout\'s own words stand', SCOUT_TOOLS_DESCRIPTION === 'read-only — Read, Glob, Grep, a read-only shell, and every other tool only in the form that reads')
}

section('§6 A DENY RULE ON A NEW TOOL inherits as it does for Bash')
{
  const base = getEmptyToolPermissionContext()
  const open = resolveWorkerTools(MERCURY_CREW_AGENT, 'default', assembleToolPool({ ...base, mode: 'default' }, []))
  const openNames = names(open)
  check('an open context hands the crewmate Bash and Git', openNames.includes('Bash') && openNames.includes('Git'), openNames.join(','))
  const denied = resolveWorkerTools(MERCURY_CREW_AGENT, 'default', assembleToolPool({ ...base, mode: 'default', alwaysDenyRules: { cliArg: ['Git', 'Bash'] } }, []))
  const deniedNames = names(denied)
  check('a parent deny on Git removes it from the crewmate as a deny on Bash does', !deniedNames.includes('Git') && !deniedNames.includes('Bash') && deniedNames.includes('Read'), deniedNames.join(','))
  const definition = resolveAgentTools({ source: 'projectSettings', tools: ['*'], disallowedTools: ['Test', 'Eval'] }, catalogue)
  const definitionNames = names(definition.resolvedTools)
  check('a definition\'s disallowedTools removes Test and Eval and keeps the rest', !definitionNames.includes('Test') && !definitionNames.includes('Eval') && definitionNames.includes('Debug') && definitionNames.includes('Bash'))
}

section('§7 THE DEFERRED ROSTER lists the new tools for a crewmate exactly as for the seat')
{
  const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const context = getEmptyToolPermissionContext()
  const first = createUserMessage({ content: 'Reply with exactly: ok' })
  const plan = async (tools: Tool[], source: string) => {
    clearToolRosterLatches()
    return planToolPayload({ model: 'claude-opus-5-5', tools, messages: [first as never], getToolPermissionContext: async () => context, agents: [], source })
  }
  const seat = await plan(catalogue, 'crewmate-toolbox-seat')
  const crew = await plan(crewPool as Tool[], 'crewmate-toolbox-crew')
  const seatDeferred = [...seat.deferredNames].filter(n => !barred.has(n)).sort()
  const crewDeferred = [...crew.deferredNames].sort()
  check('the crewmate\'s deferred names are the seat\'s minus the barred set', same(crewDeferred, seatDeferred), `seat: ${seatDeferred.join(',')} · crew: ${crewDeferred.join(',')}`)
  const crewRoster = names(crew.roster)
  for (const name of ['Test', 'Debug', 'Git', 'Monitor', 'Checkpoint', 'Rewind', 'AstEdit', 'JevEval']) {
    check(`${name} rides the crewmate's roster (deferred, loadable through ToolSearch)`, crewRoster.includes(name) && crew.deferredNames.has(name))
  }
  for (const name of ['Eval', 'AstSearch', 'ChangeSet', 'LspRead', 'ToolSearch']) {
    check(`${name} rides the crewmate's first request in full, as it rides the seat's`, crewRoster.includes(name) && !crew.deferredNames.has(name) && !seat.deferredNames.has(name))
  }
}

section('§8 THE WORDS — the Crewmate tool and docs/CREW.md say what a crewmate carries and what dies with it')
{
  const { getPrompt } = await import('../../src/tools/AgentTool/prompt.ts')
  const full = await getPrompt([MERCURY_CREW_AGENT, MERCURY_SCOUT_AGENT], false, undefined, new Set(catalogueNames))
  check('the Crewmate description names the barred set and the law, with the whole catalogue offered', full.includes('A crewmate carries every tool of this session except AskUserQuestion, ApolloReview, AskAdvisor, Computer, Journal, Workflow, CronCreate, CronDelete, ScheduleWakeup, RecordConvention and the Crewmate tool itself — the few that need the operator present or reach past its own work — in the foreground and in the background alike; the processes it starts (background shells, code kernels, the services it starts for the session, debug sessions, its browser) end when it ends.'), full.slice(full.indexOf('A crewmate carries'), full.indexOf('A crewmate carries') + 200))
  const narrow = await getPrompt([MERCURY_CREW_AGENT], false, undefined, new Set(catalogueNames.filter(n => n !== 'Computer' && n !== 'AskAdvisor')))
  check('the note names only the barred tools this session offers (no Computer, no AskAdvisor here)', narrow.includes('except AskUserQuestion, ApolloReview, Journal,') && !narrow.includes('Computer'))
  check('mercury-crew still lists as (Tools: *) — the claim the law now makes true', /- mercury-crew: .*\(Tools: \*\)/.test(full))
  const docs = src('docs/CREW.md')
  check('docs/CREW.md names the same barred set and the processes law', docs.includes('(AskUserQuestion, ApolloReview, AskAdvisor)') && docs.includes('(Computer, Journal, Workflow, CronCreate, CronDelete,\nScheduleWakeup, RecordConvention, and the Crewmate tool itself)') && docs.includes('end when it ends'))
}

console.log(`\ncrewmate-toolbox: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
