#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { existsSync, readFileSync, rmSync } from 'node:fs'
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
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getSessionId, setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { findToolByName, getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools, getTools } = await import('../../src/tools.ts')
const { buildToolCensus, censusGapLines } = await import('../../src/utils/capability/census.ts')
const { toolFamilyFor } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { gateToolCall, toolCallRefusalNote } = await import('../../src/services/providers/toolCallGate.ts')
const { addFunctionHook } = await import('../../src/utils/hooks/sessionHooks.ts')
const { validatePermissionRule } = await import('../../src/utils/settings/permissionValidation.ts')
const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.ts')
const { toolAlwaysAllowedRule, getDenyRuleForTool, getAskRuleForTool } = await import('../../src/utils/permissions/decision/rules.ts')
const { killCapability, restoreCapability, isCapabilityKilled } = await import('../../src/utils/permissions/capabilityGate.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const permission = getEmptyToolPermissionContext()
const catalogue = getAllBaseTools()
const pool = getTools(permission)
const census = buildToolCensus()

check('A1 the file courier folder is absent', !existsSync(join(root, 'src/tools', `${name}Tool`)))
for (const rel of [
  'src/tools.ts',
  'src/utils/capability/declarations.ts',
  'src/components/mercury-ui/toolGlyphs.ts',
  'src/utils/transcriptSearch.ts',
  'scripts/builtin-tools/fixtures/tool-census.json',
  'scripts/builtin-tools/fixtures/tool-census.md',
  'scripts/project-services/fixtures/inventory.json',
  'scripts/builtin-tools/prove-census-reasons.ts',
  'scripts/provider-compat/prove-tool-call-gate.ts',
]) {
  const text = readFileSync(join(root, rel), 'utf8')
  check(`A2 ${rel} has no courier spelling`, !FILE_TOOL_SPELLINGS.some(word => text.includes(word)))
}
check('A3 neither the catalogue nor either session posture resolves the name', findToolByName(catalogue, name) === undefined)
for (const interactive of [false, true]) {
  setIsInteractive(interactive)
  check(`A3 ${interactive ? 'interactive' : 'headless'} pool has no courier`, findToolByName(getTools(permission), name) === undefined)
}
setIsInteractive(false)
check('A4 neither the census nor its gap lines name the courier', !census.rows.some(row => row.name === name) && !json(censusGapLines(census)).includes(name))
check('A5 a recorded courier uses the ordinary unknown family', toolFamilyFor(name) === toolFamilyFor(nonsense) && toolFamilyFor(name) === 'system')
const agent = (toolName: string, tools = catalogue) => resolveAgentTools({ tools: ['Read', toolName], source: 'userSettings' }, tools)
for (const [label, tools] of [['catalogue', catalogue], ['session', pool]] as const) {
  const result = agent(name, tools)
  check(`A6 ${label} agent lists mark the courier unknown`, json(result.validTools) === json(['Read']) && json(result.invalidTools) === json([name]), json({ valid: result.validTools, invalid: result.invalidTools }))
}
const denied = (toolName: string) => resolveAgentTools({ tools: ['*'], disallowedTools: [toolName], source: 'userSettings' }, catalogue).resolvedTools.map(tool => tool.name)
check('agent disallowedTools takes the generic unknown-name road', json(denied(name)) === json(denied(nonsense)))

const app = { toolPermissionContext: permission, sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }
const setAppState = (update: (state: typeof app) => typeof app) => update(app)
let pre = 0
let failed = 0
for (const toolName of [name, nonsense]) {
  addFunctionHook(setAppState as never, getSessionId(), 'PreToolUse', toolName, () => { pre++; return true }, 'pre hook')
  addFunctionHook(setAppState as never, getSessionId(), 'PostToolUseFailure', toolName, () => { failed++; return true }, 'failure hook')
}
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
  check(`B1 ${spelling} returns one generic unknown-name error`, blocks.length === 1 && blocks[0]?.is_error === true && normalize(blocks, spelling) === normalize(ordinary, nonsense), json(blocks))
  const verdict = gateToolCall(pool, { id: 'call_courier', name: spelling, argumentsRaw: json(input), malformed: false })
  const generic = gateToolCall(pool, { id: 'call_courier', name: nonsense, argumentsRaw: json(input), malformed: false })
  check(`B3 ${spelling} takes the ordinary provider unknown-name gate`, !verdict.ok && verdict.refusal.code === 'unknown-tool' && normalize(verdict, spelling) === normalize(generic, nonsense), json(verdict))
  if (!verdict.ok && !generic.ok) {
    for (const lane of ['openai', 'zai', 'openaicompat']) check(`B3 ${lane} ${spelling} has the generic refusal note`, normalize(toolCallRefusalNote(lane, verdict.refusal), spelling) === normalize(toolCallRefusalNote(lane, generic.refusal), nonsense))
  }
}
check('B4 unknown calls never fire either session hook', pre === 0 && failed === 0, json({ pre, failed }))

for (const suffix of ['', '(*)', '(report.pdf)']) {
  check(`saved rule ${suffix || '(bare)'} uses ordinary syntax validation`, json(validatePermissionRule(name + suffix)) === json(validatePermissionRule(nonsense + suffix)))
  const rules = { ...permission, alwaysAllowRules: { cliArg: [name + suffix] }, alwaysDenyRules: { cliArg: [name + suffix] }, alwaysAskRules: { cliArg: [name + suffix] } }
  check(`saved rule ${suffix || '(bare)'} matches no live builtin`, catalogue.every(tool => toolAlwaysAllowedRule(rules, tool) === null && getDenyRuleForTool(rules, tool) === null && getAskRuleForTool(rules, tool) === null))
}
const cli = async (toolName: string) => initializeToolPermissionContext({ allowedToolsCli: [toolName], disallowedToolsCli: [toolName], permissionMode: 'default', allowDangerouslySkipPermissions: false })
check('CLI allow and block lists keep the generic unknown-name effect and warnings', normalize(await cli(name), name) === normalize(await cli(nonsense), nonsense))
for (const toolName of [name, nonsense]) {
  killCapability('*', toolName)
  check(`${toolName} kill matches no builtin`, catalogue.every(tool => !isCapabilityKilled(tool.name)))
  check(`${toolName} kill keeps ordinary MCP-server matching`, isCapabilityKilled(`mcp__${toolName}__read`))
  restoreCapability('*', toolName)
}
const search = async (toolName: string) => (await ToolSearchTool.call({ query: `select:${toolName}`, max_results: 5 }, context as never)).data
check('ToolSearch select takes the same unknown-name road', normalize(await search(name), name) === normalize(await search(nonsense), nonsense))
console.log(`census tools: ${census.summary.tools}`)
console.log(failures === 0 ? 'file courier absence: ALL PASS' : `file courier absence: ${failures} FAILED`)
rmSync(proofHome, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
