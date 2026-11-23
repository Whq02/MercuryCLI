#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FILE_TOOL_SPELLINGS } from '../identity/forbidden-file-tool.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const name = FILE_TOOL_SPELLINGS[0]
const nonsense = 'FrobnicateTool'
const root = resolve(import.meta.dir, '../..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const json = (value: unknown): string => JSON.stringify(value)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getSessionId, setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const { findToolByName, getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getAllBaseTools, getTools } = await import('../../src/tools/kit/toolList.ts')
const { buildToolCensus, censusGapLines } = await import('../../src/permissions/capability-census/census.ts')
const { toolFamilyFor } = await import('../../src/screen/widgets/toolGlyphs.ts')
const { resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.ts')
const { gateToolCall, toolCallRefusalNote } = await import('../../src/models/roads/toolCallGate.ts')
const { engageToolGuard } = await import('../../src/permissions/guards/guards.ts')
const { addSessionHooks } = await import('../../src/integrations/event-hooks/sessionHooks.ts')
const { validatePermissionRule } = await import('../../src/platform/settings/permissionValidation.ts')
const { initializeToolPermissionContext } = await import('../../src/permissions/rules/permissionSetup.ts')
const { toolAlwaysAllowedRule, getDenyRuleForTool, getAskRuleForTool } = await import('../../src/permissions/rules/decision/rules.ts')
const { killCapability, restoreCapability, isCapabilityKilled } = await import('../../src/permissions/rules/capabilityGate.ts')
const { ToolSearchTool } = await import('../../src/tools/tool-search/ToolSearchTool.ts')
const permission = getEmptyToolPermissionContext()
const catalogue = getAllBaseTools()
const pool = getTools(permission)
const census = buildToolCensus()

check('A1 the file courier folder is absent', !existsSync(join(root, 'src/tools', `${name}Tool`)), `delete the src/tools/${name}Tool folder`)
check('A3 neither the catalogue nor either session posture resolves the name', findToolByName(catalogue, name) === undefined, 'remove the courier tool from getAllBaseTools in src/tools/kit/toolList.ts')
for (const interactive of [false, true]) {
  setIsInteractive(interactive)
  check(`A3 ${interactive ? 'interactive' : 'headless'} pool has no courier`, findToolByName(getTools(permission), name) === undefined, 'remove the courier tool from getTools in src/tools/kit/toolList.ts')
}
setIsInteractive(false)
check('A4 neither the census nor its gap lines name the courier', !census.rows.some(row => row.name === name) && !json(censusGapLines(census)).includes(name), 'remove the courier name from buildToolCensus in src/permissions/capability-census/census.ts')
check('A5 a recorded courier uses the ordinary unknown family', toolFamilyFor(name) === toolFamilyFor(nonsense) && toolFamilyFor(name) === 'system', 'drop any courier-specific family entry in toolFamilyFor in src/screen/widgets/toolGlyphs.ts')
const agent = (toolName: string, tools = catalogue) => resolveAgentTools({ tools: ['Read', toolName], source: 'userSettings' }, tools)
for (const [label, tools] of [['catalogue', catalogue], ['session', pool]] as const) {
  const result = agent(name, tools)
  check(`A6 ${label} agent lists mark the courier unknown`, json(result.validTools) === json(['Read']) && json(result.invalidTools) === json([name]), json({ valid: result.validTools, invalid: result.invalidTools }) + ' | resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts must treat the courier name as unknown')
}
const denied = (toolName: string) => resolveAgentTools({ tools: ['*'], disallowedTools: [toolName], source: 'userSettings' }, catalogue).resolvedTools.map(tool => tool.name)
check('agent disallowedTools takes the generic unknown-name road', json(denied(name)) === json(denied(nonsense)), 'resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts must not special-case the courier name in disallowedTools')

const app = { toolPermissionContext: permission, sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }
const setAppState = (update: (state: typeof app) => typeof app) => update(app)
let pre = 0
const failedMark = join(proofHome, 'tool-after-fired')
engageToolGuard(String(getSessionId()), { id: 'courier-guard', tools: [name, nonsense], judge: async () => { pre++; return { allow: true } } })
addSessionHooks(setAppState as never, { sessionId: String(getSessionId()) }, { 'tool.after': [{ name: 'after mark', run: `touch ${JSON.stringify(failedMark)}` }] } as never, { kind: 'agent', type: 'courier-rig' })
const context = {
  abortController: new AbortController(),
  getAppState: () => app,
  setAppState,
  messages: [],
  toolDecisions: new Map(),
  readFileState: new Map(),
  options: { tools: pool, mcpClients: [], isNonInteractiveSession: true },
}
const input = { files: ['/proof/report.pdf'], status: 'normal' }
type Result = { type: string; tool_use_id: string; is_error?: boolean; content?: unknown }
async function call(toolName: string): Promise<Result[]> {
  const blocks: Result[] = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_courier', name: toolName, input } as never,
    { uuid: 'courier-uuid', requestId: 'courier-request', message: { id: 'courier-message' } } as never,
    (async () => { throw new Error('unknown tools must not reach permission checks') }) as never,
    context as never,
  )) {
    const content = (update as { message?: { message?: { content?: Result[] } } }).message?.message?.content
    if (Array.isArray(content)) blocks.push(...content.filter(block => block.type === 'tool_result'))
  }
  return blocks
}
const ordinary = await call(nonsense)
const normalize = (value: unknown, toolName: string): string => json(value).replaceAll(toolName, '<unknown>')
for (const spelling of [name, FILE_TOOL_SPELLINGS[2], FILE_TOOL_SPELLINGS[3]]) {
  const blocks = await call(spelling)
  check(`B1 ${spelling} returns one generic unknown-name error`, blocks.length === 1 && blocks[0]?.is_error === true && normalize(blocks, spelling) === normalize(ordinary, nonsense), json(blocks) + ' | runToolUse in src/engine/tool-dispatch/toolExecution.ts must give this name the same unknown-tool error as any unknown name')
  const verdict = gateToolCall(pool, { id: 'call_courier', name: spelling, argumentsRaw: json(input), malformed: false })
  const generic = gateToolCall(pool, { id: 'call_courier', name: nonsense, argumentsRaw: json(input), malformed: false })
  check(`B3 ${spelling} takes the ordinary provider unknown-name gate`, !verdict.ok && verdict.refusal.code === 'unknown-tool' && normalize(verdict, spelling) === normalize(generic, nonsense), json(verdict) + ' | gateToolCall in src/models/roads/toolCallGate.ts must refuse this name as unknown-tool like any unknown name')
  if (!verdict.ok && !generic.ok) {
    for (const lane of ['openai', 'zai', 'openaicompat']) check(`B3 ${lane} ${spelling} has the generic refusal note`, normalize(toolCallRefusalNote(lane, verdict.refusal), spelling) === normalize(toolCallRefusalNote(lane, generic.refusal), nonsense), 'toolCallRefusalNote in src/models/roads/toolCallGate.ts must not special-case this name')
  }
}
check('B4 unknown calls never reach the tool guard nor fire tool.after', pre === 0 && !existsSync(failedMark), json({ pre, after: existsSync(failedMark) }) + ' | runToolUse in src/engine/tool-dispatch/toolExecution.ts must return the unknown-tool error before the tool guard and tool.after hooks')

for (const suffix of ['', '(*)', '(report.pdf)']) {
  check(`saved rule ${suffix || '(bare)'} uses ordinary syntax validation`, json(validatePermissionRule(name + suffix)) === json(validatePermissionRule(nonsense + suffix)), 'validatePermissionRule in src/platform/settings/permissionValidation.ts must not special-case the courier name')
  const rules = { ...permission, alwaysAllowRules: { cliArg: [name + suffix] }, alwaysDenyRules: { cliArg: [name + suffix] }, alwaysAskRules: { cliArg: [name + suffix] } }
  check(`saved rule ${suffix || '(bare)'} matches no live builtin`, catalogue.every(tool => toolAlwaysAllowedRule(rules, tool) === null && getDenyRuleForTool(rules, tool) === null && getAskRuleForTool(rules, tool) === null), 'a catalogue tool matches a saved courier rule; check src/permissions/rules/decision/rules.ts and remove the courier tool from the catalogue')
}
const cli = async (toolName: string) => initializeToolPermissionContext({ allowedToolsCli: [toolName], disallowedToolsCli: [toolName], permissionMode: 'default', allowDangerouslySkipPermissions: false })
check('CLI allow and block lists keep the generic unknown-name effect and warnings', normalize(await cli(name), name) === normalize(await cli(nonsense), nonsense), 'initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts must not special-case the courier name')
for (const toolName of [name, nonsense]) {
  killCapability('*', toolName)
  check(`${toolName} kill matches no builtin`, catalogue.every(tool => !isCapabilityKilled(tool.name)), 'a builtin matched the kill; check killCapability in src/permissions/rules/capabilityGate.ts')
  check(`${toolName} kill keeps ordinary MCP-server matching`, isCapabilityKilled(`mcp__${toolName}__read`), 'check isCapabilityKilled in src/permissions/rules/capabilityGate.ts')
  restoreCapability('*', toolName)
}
const search = async (toolName: string) => (await ToolSearchTool.call({ query: `select:${toolName}`, max_results: 5 }, context as never)).data
check('ToolSearch select takes the same unknown-name road', normalize(await search(name), name) === normalize(await search(nonsense), nonsense), 'ToolSearchTool in src/tools/tool-search/ToolSearchTool.ts must not special-case the courier name')
console.log(`census tools: ${census.summary.tools}`)
console.log(failures === 0 ? 'file courier absence: ALL PASS' : `file courier absence: ${failures} FAILED`)
rmSync(proofHome, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
