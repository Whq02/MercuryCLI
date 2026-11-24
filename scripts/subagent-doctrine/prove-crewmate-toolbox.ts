#!/usr/bin/env bun
import '../lib/hermetic.ts'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL']) delete process.env[k]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: 'true', args: [], connect: 'stdio' } })


let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, jev: { ...(config.jev ?? {}), enabled: true, subagents: true } }))
await import('../../src/models/roads/callModelRouter.ts')
await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const toolsConstants = (await import('../../src/tools/kit/crewmateBarredTools.ts')) as Record<string, unknown>
const { filterToolsForCrewmate, resolveCrewmateTools, resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
const { MERCURY_CREW_AGENT } = await import('../../src/tools/crewmate/built-in/mercuryCrewAgent.ts')
const { MERCURY_SCOUT_AGENT } = await import('../../src/tools/crewmate/built-in/mercuryScoutAgent.ts')
const { restrictScoutTools, SCOUT_TOOLS_DESCRIPTION } = await import('../../src/tools/crewmate/scoutPolicy.ts')
const { getAllBaseTools, assembleToolPool } = await import('../../src/tools/kit/toolList.ts')
const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { JevEvalTool } = await import('../../src/tools/jev-eval/JevEvalTool.ts')
const { AskAdvisorTool } = await import('../../src/tools/ask-advisor/AskAdvisorTool.ts')
const { DebugTool } = await import('../../src/tools/debug/DebugTool.ts')
const { EvalTool } = await import('../../src/tools/eval/EvalTool.ts')
const { JournalTool } = await import('../../src/tools/journal/JournalTool.ts')
const { LSP_TOOLS } = await import('../../src/tools/lsp/lspTools.ts')
const { EnterWorktreeTool } = await import('../../src/tools/enter-worktree/EnterWorktreeTool.ts')
const { ExitWorktreeTool } = await import('../../src/tools/exit-worktree/ExitWorktreeTool.ts')
const { TaskCreateTool } = await import('../../src/tools/task-create/TaskCreateTool.ts')
const { TaskGetTool } = await import('../../src/tools/task-get/TaskGetTool.ts')
const { TaskUpdateTool } = await import('../../src/tools/task-update/TaskUpdateTool.ts')
const { TaskListTool } = await import('../../src/tools/task-list/TaskListTool.ts')
type Tool = import('../../src/tools/kit/tool.ts').Tool

console.log("crewmate-toolbox: a crewmate's toolbox is the main seat's minus the BARRED set, foreground and background alike (the owner's ruling, 2026-10-16)")
const names = (list: readonly { name: string }[]): string[] => list.map(t => t.name).sort()
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((n, i) => n === b[i])

const catalogue: Tool[] = [...getAllBaseTools()]
for (const tool of [ComputerTool, JevEvalTool, AskAdvisorTool, DebugTool, EvalTool, JournalTool, ...LSP_TOOLS, EnterWorktreeTool, ExitWorktreeTool, TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] as Tool[]) {
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
  CronCreate: 'past its own work',
  CronDelete: 'past its own work',
  ScheduleWakeup: 'past its own work',
  RecordConvention: 'past its own work',
  Crewmate: 'recursion',
}
const table = (toolsConstants.CREWMATE_BARRED_TOOLS ?? {}) as Record<string, string>
const barred = toolsConstants.ALL_CREWMATE_DISALLOWED_TOOLS as Set<string>
for (const [name, reason] of Object.entries(BARRED)) {
  check(`${name} is barred — ${reason}`, barred.has(name) && table[name] === reason, `table says ${JSON.stringify(table[name])} | add or fix the row in CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts`)
}
check('the barred set is exactly these ten', same([...barred].sort(), Object.keys(BARRED).sort()), [...barred].sort().join(',') + ' | CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts must hold exactly the BARRED rows of this file')
check('custom definitions bar the same set (one deny set)', toolsConstants.CUSTOM_CREWMATE_DISALLOWED_TOOLS === barred, 'CUSTOM_CREWMATE_DISALLOWED_TOOLS in src/tools/kit/crewmateBarredTools.ts must be the same set object as ALL_CREWMATE_DISALLOWED_TOOLS')
for (const name of Object.keys(BARRED)) {
  check(`${name} exists in the catalogue (a barred row names a real tool)`, catalogueNames.includes(name), 'remove this row from CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts, or register the tool in src/tools/kit/toolList.ts (getAllBaseTools)')
}


section('§3 A CREWMATE\'S POOL = the catalogue minus barred — every tool named, foreground and background one derivation')
const crewPool = resolveCrewmateTools(MERCURY_CREW_AGENT, 'default', catalogue)
const crewNames = names(crewPool)
const expected = catalogueNames.filter(n => !barred.has(n))
check('mercury-crew (tools: *) resolves to the catalogue minus the barred set, exactly', same(crewNames, expected), `missing: ${expected.filter(n => !crewNames.includes(n)).join(',')} · extra: ${crewNames.filter(n => !expected.includes(n)).join(',')} | resolveWorkerTools in src/tools/crewmate/crewmateLifecycle.ts must return the catalogue minus CREWMATE_BARRED_TOOLS`)
const NEWLY_REACHABLE = ['Eval', 'Test', 'Debug', 'Launch', 'Service', 'Monitor', 'Browser', 'Journey', 'Git', 'Transaction', 'Structure', 'AstSearch', 'AstEdit', 'ChangeSet', 'LspRead', 'LspRename', 'LspMoveSymbol', 'LspMoveFile', 'LspCodeAction', 'LspFormat', 'LspRequest', 'Inspect', 'Checkpoint', 'Rewind', 'CronList', 'JevEval']
for (const name of NEWLY_REACHABLE) {
  check(`a crewmate carries ${name}`, crewNames.includes(name), 'resolveWorkerTools in src/tools/crewmate/crewmateLifecycle.ts must not drop this tool; check CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts')
}
const KEPT = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ProviderSearch', 'Skill', 'ToolSearch', 'Sleep', 'ContextLeft', 'SendMessage', 'ResumeCrewmate', 'EnterWorktree', 'ExitWorktree', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'Retain', 'Recall', 'Reflect', 'Correct']
check('every tool a crewmate had before stays', KEPT.every(n => crewNames.includes(n)), KEPT.filter(n => !crewNames.includes(n)).join(',') + ' | missing tools above; resolveWorkerTools in src/tools/crewmate/crewmateLifecycle.ts or CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts removed them')
const filtered = names(filterToolsForCrewmate({ tools: catalogue, isBuiltIn: true }))
check('the filter alone gives the same set (the definition adds no narrowing for tools: *)', same(filtered, expected), 'filterToolsForAgent in src/tools/crewmate/crewmateLifecycle.ts must remove only the CREWMATE_BARRED_TOOLS names for a built-in agent')
const custom = names(filterToolsForCrewmate({ tools: catalogue, isBuiltIn: false }))
check('a custom definition sees the same pool before its own tools: list narrows it', same(custom, expected), 'filterToolsForAgent in src/tools/crewmate/crewmateLifecycle.ts must apply the same deny set to a custom definition')

section('§4 MCP TOOLS PASS')
{
  const mcp = [{ name: 'mcp__fixture__lookup' }, { name: 'mcp__fixture__store' }] as unknown as Tool[]
  const kept = names(filterToolsForCrewmate({ tools: [...catalogue, ...mcp], isBuiltIn: true }))
  check('both fixture MCP tools ride to a crewmate', kept.includes('mcp__fixture__lookup') && kept.includes('mcp__fixture__store'), 'filterToolsForAgent in src/tools/crewmate/crewmateLifecycle.ts must let mcp__ tools through')
}

section('§5 THE SCOUT\'S READ-ONLY FORM holds — no Eval, no Test, no editors, no messaging')
{
  const scoutPool = restrictScoutTools(resolveCrewmateTools(MERCURY_SCOUT_AGENT, 'default', catalogue))
  const scout = names(scoutPool)
  for (const name of ['Read', 'Glob', 'Grep', 'Bash', 'Inspect', 'Git', 'Structure', 'AstSearch', 'ChangeSet', 'CronList', 'WebFetch', 'Skill']) {
    check(`the scout keeps ${name} (its reading form)`, scout.includes(name), 'restrictScoutTools in src/tools/crewmate/scoutPolicy.ts must keep this tool')
  }
  for (const name of ['Eval', 'Test', 'Edit', 'Write', 'NotebookEdit', 'Browser', 'Launch', 'Transaction', 'Monitor', 'Crewmate', 'SendMessage', 'ResumeCrewmate', 'EnterWorktree', 'ExitWorktree', 'Retain', 'Correct', ...Object.keys(BARRED)]) {
    check(`the scout never carries ${name}`, !scout.includes(name), 'restrictScoutTools in src/tools/crewmate/scoutPolicy.ts must drop this tool from the scout pool')
  }
  check('the scout\'s own words stand', SCOUT_TOOLS_DESCRIPTION === 'read-only — Read, Glob, Grep, a read-only shell, and every other tool only in the form that reads', 'SCOUT_TOOLS_DESCRIPTION in src/tools/crewmate/scoutPolicy.ts changed; restore it or update the expected words here')
}

section('§6 A DENY RULE ON A NEW TOOL inherits as it does for Bash')
{
  const base = getEmptyToolPermissionContext()
  const open = resolveCrewmateTools(MERCURY_CREW_AGENT, 'default', assembleToolPool({ ...base, mode: 'default' }, []))
  const openNames = names(open)
  check('an open context hands the crewmate Bash and Git', openNames.includes('Bash') && openNames.includes('Git'), openNames.join(',') + ' | assembleToolPool in src/tools/kit/toolList.ts with resolveWorkerTools in src/tools/crewmate/crewmateLifecycle.ts must hand the crewmate Bash and Git when nothing is denied')
  const denied = resolveCrewmateTools(MERCURY_CREW_AGENT, 'default', assembleToolPool({ ...base, mode: 'default', alwaysDenyRules: { cliArg: ['Git', 'Bash'] } }, []))
  const deniedNames = names(denied)
  check('a parent deny on Git removes it from the crewmate as a deny on Bash does', !deniedNames.includes('Git') && !deniedNames.includes('Bash') && deniedNames.includes('Read'), deniedNames.join(',') + ' | alwaysDenyRules must remove Git and Bash in assembleToolPool (src/tools/kit/toolList.ts) before resolveWorkerTools in src/tools/crewmate/crewmateLifecycle.ts')
  const definition = resolveAgentTools({ source: 'projectSettings', tools: ['*'], disallowedTools: ['Test', 'Eval'] }, catalogue)
  const definitionNames = names(definition.resolvedTools)
  check('a definition\'s disallowedTools removes Test and Eval and keeps the rest', !definitionNames.includes('Test') && !definitionNames.includes('Eval') && definitionNames.includes('Debug') && definitionNames.includes('Bash'), 'resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts must apply a definition disallowedTools list and keep the rest')
}

section('§7 THE DEFERRED ROSTER lists the new tools for a crewmate exactly as for the seat')
{
  const { planToolPayload, clearToolRosterLatches } = await import('../../src/models/roads/toolEconomy.ts')
  const { ECONOMY_DEFERRED } = await import('../../src/tools/tool-search/prompt.ts')
  const { ToolSearchTool } = await import('../../src/tools/tool-search/ToolSearchTool.ts')
  const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
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
  check('the crewmate\'s deferred names are the seat\'s minus the barred set', same(crewDeferred, seatDeferred), `seat: ${seatDeferred.join(',')} · crew: ${crewDeferred.join(',')} | planToolPayload in src/models/roads/toolEconomy.ts must defer the same tools for the crewmate pool as for the seat`)
  const crewRoster = names(crew.roster)
  const economyForCrew = [...ECONOMY_DEFERRED].filter(n => !barred.has(n)).sort()
  check('the economy-deferred tools a crewmate carries are AstSearch, LspRead, Skill and Test (Crewmate is barred), each deferred on a hosted route for the crewmate as for the seat', same(economyForCrew, ['AstSearch', 'LspRead', 'Skill', 'Test']) && economyForCrew.every(n => crewRoster.includes(n) && crew.deferredNames.has(n) && seat.deferredNames.has(n)), `economy: ${economyForCrew.join(',')} · crew deferred: ${crewDeferred.join(',')} | ECONOMY_DEFERRED in src/tools/tool-search/prompt.ts and planToolPayload in src/models/roads/toolEconomy.ts decide this`)
  for (const name of ['Test', 'Debug', 'Git', 'Monitor', 'Checkpoint', 'Rewind', 'AstEdit', 'JevEval', 'AstSearch', 'LspRead', 'Skill']) {
    check(`${name} rides the crewmate's roster (deferred, loadable through ToolSearch)`, crewRoster.includes(name) && crew.deferredNames.has(name), 'planToolPayload in src/models/roads/toolEconomy.ts must list this tool in the crewmate roster as deferred')
  }
  for (const name of ['Eval', 'ChangeSet', 'ToolSearch']) {
    check(`${name} rides the crewmate's first request in full, as it rides the seat's`, crewRoster.includes(name) && !crew.deferredNames.has(name) && !seat.deferredNames.has(name), 'planToolPayload in src/models/roads/toolEconomy.ts must send this tool in full on the first request, for crewmate and seat alike')
  }
  const asked = await ToolSearchTool.call({ query: 'select:AstSearch', max_results: 5 }, { messages: [first], options: { tools: crewPool, engineModel: 'claude-opus-5-5' }, getAppState: () => ({ toolPermissionContext: { ...context, mode: 'default' }, mcp: { clients: [] } }) } as never)
  const handed = ToolSearchTool.mapToolResultToToolResultBlockParam(asked.data, 'crewmate-asks-for-astsearch')
  check('a crewmate asking ToolSearch for AstSearch gets it: the match is AstSearch and the result hands its model the tool reference', asked.data.matches.includes('AstSearch') && asked.data.total_deferred_tools === crew.deferredNames.size && Array.isArray(handed.content) && (handed.content as Array<{ type: string; tool_name?: string }>).some(block => block.type === 'tool_reference' && block.tool_name === 'AstSearch'), JSON.stringify(asked.data) + ' | ToolSearchTool in src/tools/tool-search/ToolSearchTool.ts must match select:AstSearch against the crewmate pool and return a tool_reference block')
}

section('§8 THE WORDS — the Crewmate tool says what a crewmate carries and what dies with it')
{
  const { getPrompt } = await import('../../src/tools/crewmate/prompt.ts')
  const full = await getPrompt([MERCURY_CREW_AGENT, MERCURY_SCOUT_AGENT], false, undefined, new Set(catalogueNames))
  check('the manual states tool access without repeating the barred-tool roster', full.includes("Tool access follows the selected agent definition and the session's permissions.") && full.includes('Foreground and background launches have the same tool access.') && !full.includes('A crewmate carries every tool of this session except'), 'getPrompt in src/tools/crewmate/prompt.ts must state the tool-access sentences and not list the barred tools')
  const narrow = await getPrompt([MERCURY_CREW_AGENT], false, undefined, new Set(catalogueNames.filter(n => n !== 'Computer' && n !== 'AskAdvisor')))
  check('the manual does not teach an unavailable tool', !narrow.includes('Computer') && !narrow.includes('AskAdvisor'), 'getPrompt in src/tools/crewmate/prompt.ts must leave out tools missing from the available-tools set it is given')
  check('mercury-crew still lists as (Tools: *) — the claim the law now makes true', /- mercury-crew: .*\(Tools: \*\)/.test(full), 'getPrompt in src/tools/crewmate/prompt.ts must list mercury-crew with (Tools: *)')
}

console.log(`\ncrewmate-toolbox: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
