#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cloud-loaded-tools-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: 'true', args: [], connect: 'stdio' } })
process.env.TYPESAFE_API_KEY = 'proof-key-cloud-loaded-tools-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, jev: { ...(config.jev ?? {}), enabled: true } }))
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { planToolPayload, clearToolRosterLatches, armToolRosterRestore, clearToolRosterRestore, conversationRosterKey, heldToolsAtLastPlan } = await import('../../src/services/providers/toolEconomy.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool, getAllBaseTools } = await import('../../src/tools.ts')
const { MCPTool } = await import('../../src/tools/MCPTool/MCPTool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const predicates = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = predicates
type RoutePredicate = (tool: Tool, model: string | undefined, permissionMode?: string, messages?: readonly Message[]) => boolean
const isDeferredToolFor: RoutePredicate = (predicates as { isDeferredToolFor?: RoutePredicate }).isDeferredToolFor ?? ((tool, _model, permissionMode) => isDeferredTool(tool, permissionMode))
const loadsInFullFor: RoutePredicate = (predicates as { loadsInFullFor?: RoutePredicate }).loadsInFullFor ?? (() => false)
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { buildSchemaNotSentHint } = await import('../../src/services/tools/toolExecution.ts')
const { openrouterNativeTools } = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.ts')
const { supportsToolDeferral, deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const FULL_NAMES = ['ChangeSet', 'AstSearch', 'LspRead']
const NINE_NAMES = ['JevEval', 'Debug', 'Git', 'AstEdit', 'Test', 'Workshop', 'Monitor', 'Checkpoint', 'Rewind']
const MARKED_NAMES = [...FULL_NAMES, ...NINE_NAMES]
const LOCAL_SET = ['Agent', 'Bash', 'Edit', 'Eval', 'Glob', 'Grep', 'Read', 'ScheduleWakeup', 'Skill', 'ToolSearch', 'Write']

const permissionContext = getEmptyToolPermissionContext()
const pool: Tool[] = [...assembleToolPool(permissionContext, buildFixtureMcpTools<Tool>(MCPTool))]
const catalogue = getAllBaseTools()
const absentHere = MARKED_NAMES.filter(name => !pool.some(item => item.name === name))
for (const name of absentHere) {
  const tool = catalogue.find(item => item.name === name)
  if (tool !== undefined) pool.push(tool)
}
console.log(`  ${absentHere.length === 0 ? 'every one of the twelve is enabled in this environment' : `added to the pool from the catalogue because this environment's gates leave them out: ${absentHere.join(', ')}`}`)
const FULL: Tool[] = FULL_NAMES.flatMap(name => pool.filter(tool => tool.name === name))
const NINE: Tool[] = NINE_NAMES.flatMap(name => pool.filter(tool => tool.name === name))
check('the three that load in full are in the pool', FULL.length === FULL_NAMES.length, FULL_NAMES.filter(name => !FULL.some(tool => tool.name === name)).join(', '))
check('the nine are in the pool', NINE.length === NINE_NAMES.length, NINE_NAMES.filter(name => !NINE.some(tool => tool.name === name)).join(', '))
const ChangeSetTool = FULL.find(tool => tool.name === 'ChangeSet') as Tool
const first = createUserMessage({ content: 'begin' }) as Message
const stillDeferred = pool.filter(tool => isDeferredTool(tool) && tool.loadInFullOnCloud !== true && tool.isMcp !== true).map(tool => tool.name)
console.log(`  the pool: ${pool.length} tools · the three present: ${FULL_NAMES.filter(name => pool.some(tool => tool.name === name)).length}/3 · the nine present: ${NINE_NAMES.filter(name => pool.some(tool => tool.name === name)).length}/9 · in the drawer by declaration: ${stillDeferred.length} (${stillDeferred.slice(0, 5).join(', ')}, …)`)

const CLOUD: Array<[string, string]> = [
  ['anthropic first-party (block form)', 'claude-sonnet-5'],
  ['openai native form', 'gpt-5.6-sol'],
  ['openai text form', 'gpt-5.3-codex'],
  ['moonshot text-append form', 'kimi-k3'],
  ['openrouter native form', 'openrouter/qwen/qwen3-coder'],
  ['zai', 'glm-5.3'],
  ['deepseek', 'deepseek-v4-pro'],
  ['gemini', 'gemini-3-pro'],
  ['huggingface', 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813'],
  ['the compat endpoint', 'compat/qwen-max'],
]
const LOCAL = 'local/qwen3-32b'

section('§1 the predicate — the three load in full on every route that is not the local lane; the nine are deferred everywhere')
check('every one of the three declares itself deferrable AND loaded in full on cloud', FULL.every(tool => tool.shouldDefer === true && tool.loadInFullOnCloud === true))
check('every one of the nine declares itself deferrable and NOT loaded in full on cloud', NINE.every(tool => tool.shouldDefer === true && tool.loadInFullOnCloud !== true), NINE.filter(tool => !(tool.shouldDefer === true && tool.loadInFullOnCloud !== true)).map(tool => tool.name).join(', '))
for (const [label, model] of CLOUD) {
  check(`${label}: none of the three is deferred for ${model}`, FULL.every(tool => !isDeferredToolFor(tool, model) && loadsInFullFor(tool, model)))
  check(`${label}: every one of the nine is deferred for ${model}`, NINE.every(tool => isDeferredToolFor(tool, model) && !loadsInFullFor(tool, model)), NINE.filter(tool => !isDeferredToolFor(tool, model)).map(tool => tool.name).join(', '))
}
check(`the local lane: every one of the twelve is deferred for ${LOCAL}`, [...FULL, ...NINE].every(tool => isDeferredToolFor(tool, LOCAL) && !loadsInFullFor(tool, LOCAL)))
check('without a model the answer is the declaration', [...FULL, ...NINE].every(tool => isDeferredToolFor(tool, undefined) === isDeferredTool(tool)))
check('a tool that does not carry the mark keeps its declaration on cloud', stillDeferred.every(name => isDeferredToolFor(pool.find(tool => tool.name === name)!, 'claude-sonnet-5')))

section('§2 the plan — on every deferring cloud route the three ride unmarked and the nine ride marked; the drawer holds the rest')
for (const [label, model] of CLOUD) {
  clearToolRosterLatches()
  const plan = await planToolPayload({ model, tools: pool, messages: [first], getToolPermissionContext: async () => permissionContext, agents: [], source: 'cloud-loaded' })
  const rosterNames = new Set(plan.roster.map(tool => tool.name))
  const deferring = supportsToolDeferral(model)
  const missing = FULL_NAMES.filter(name => !rosterNames.has(name))
  const marked = FULL_NAMES.filter(name => plan.deferredNames.has(name))
  const unadmitted = FULL_NAMES.filter(name => plan.isDeferredUnadmitted(name))
  check(`${label} (${model}, ${plan.wireForm}${deferring ? ', deferring' : ', deferral off'}): every one of the three is in the roster`, missing.length === 0, missing.join(', '))
  check(`${label}: none of the three is marked deferred or held for admission`, marked.length === 0 && unadmitted.length === 0, `marked ${marked.join(', ')} · unadmitted ${unadmitted.join(', ')}`)
  if (deferring) {
    const nineUnmarked = NINE_NAMES.filter(name => !plan.deferredNames.has(name))
    check(`${label}: every one of the nine is marked deferred`, nineUnmarked.length === 0, nineUnmarked.join(', '))
    if (plan.enabled && !plan.wireForm.endsWith('native')) {
      const nineAdmitted = NINE_NAMES.filter(name => !plan.isDeferredUnadmitted(name))
      check(`${label}: every one of the nine waits for admission`, nineAdmitted.length === 0, nineAdmitted.join(', '))
    }
    const drawer = stillDeferred.filter(name => plan.deferredNames.has(name))
    check(`${label}: the drawer still holds the tools that stay deferred by declaration`, drawer.length === stillDeferred.length, `${drawer.length}/${stillDeferred.length}`)
  } else {
    check(`${label}: with deferral off none of the nine is marked`, NINE_NAMES.every(name => !plan.deferredNames.has(name)))
  }
  if (plan.wireForm === 'block') {
    const schemas = await Promise.all(FULL.map(tool => toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model, deferLoading: plan.deferredNames.has(tool.name) })))
    check(`${label}: the block-form schemas of the three carry no defer_loading mark and a non-empty name`, schemas.every(schema => (schema as { defer_loading?: boolean }).defer_loading === undefined && typeof (schema as { name?: string }).name === 'string'))
    const nineSchemas = await Promise.all(NINE.map(tool => toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: plan.roster, agents: [], model, deferLoading: plan.deferredNames.has(tool.name) })))
    check(`${label}: the block-form schemas of the nine carry defer_loading: true`, nineSchemas.every(schema => (schema as { defer_loading?: boolean }).defer_loading === true))
  }
  if (plan.wireForm === 'openrouter-native') {
    const compat = plan.roster.map(tool => ({ type: 'function', function: { name: tool.name, description: 'd', parameters: { type: 'object' } } }))
    const wire = openrouterNativeTools(compat as never, plan.deferredNames) as Array<{ name?: string; defer_loading?: boolean }>
    check(`${label}: the openrouter wire carries the three without defer_loading and the nine and the drawer with it`, FULL_NAMES.every(name => wire.some(row => row.name === name && row.defer_loading === undefined)) && [...NINE_NAMES, ...stillDeferred].every(name => wire.some(row => row.name === name && row.defer_loading === true)))
  }
  const row = getDeferredToolsDeltaAttachment(pool, model, [first])[0] as { addedNames?: string[] } | undefined
  if (deferring && plan.enabled && !plan.wireForm.endsWith('native')) {
    check(`${label}: the announcement names none of the three, every one of the nine and every tool still in the drawer`, row !== undefined && FULL_NAMES.every(name => !(row.addedNames ?? []).includes(name)) && [...NINE_NAMES, ...stillDeferred].every(name => (row.addedNames ?? []).includes(name)), row === undefined ? 'no row' : `three named: ${(row.addedNames ?? []).filter(name => FULL_NAMES.includes(name)).join(', ')} · nine missing: ${NINE_NAMES.filter(name => !(row.addedNames ?? []).includes(name)).join(', ')}`)
  } else if (row !== undefined) {
    check(`${label}: the announcement names none of the three`, FULL_NAMES.every(name => !(row.addedNames ?? []).includes(name)))
  }
}

section('§3 the local lane — the twelve in the drawer, the roster the never-deferred set without JevEval and Workshop')
{
  clearToolRosterLatches()
  const plan = await planToolPayload({ model: LOCAL, tools: pool, messages: [first], getToolPermissionContext: async () => permissionContext, agents: [], source: 'cloud-loaded' })
  const rosterNames = plan.roster.map(tool => tool.name)
  check(`${LOCAL} rides the text form and defers`, plan.wireForm === 'text' && plan.enabled, `${plan.wireForm}/${plan.enabled}`)
  check('every one of the twelve is marked deferred on the local lane', MARKED_NAMES.every(name => plan.deferredNames.has(name)))
  check('none of the twelve has a schema in the local roster', MARKED_NAMES.every(name => !rosterNames.includes(name)))
  const expected = pool.filter(tool => !isDeferredTool(tool)).map(tool => tool.name)
  check('the local roster is exactly the never-deferred set in pool order, ToolSearch at its place', rosterNames.join(',') === expected.join(','), rosterNames.join(','))
  const outside = rosterNames.filter(name => !LOCAL_SET.includes(name))
  check(`the local roster carries no name outside the local set (${LOCAL_SET.length} names; JevEval and Workshop are in the drawer there too)`, outside.length === 0, outside.join(', '))
  const row = getDeferredToolsDeltaAttachment(pool, LOCAL, [first])[0] as { addedNames?: string[] } | undefined
  check('the local announcement names all twelve', row !== undefined && MARKED_NAMES.every(name => (row.addedNames ?? []).includes(name)))
  console.log(`  local roster (${rosterNames.length}): ${rosterNames.join(', ')}`)
  const schemas = await Promise.all(plan.roster.map(tool => toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: pool, agents: [], model: LOCAL })))
  const bytes = JSON.stringify({ tools: schemas, drawer: row?.addedNames })
  console.log(`  LOCAL SNAPSHOT ${Buffer.byteLength(bytes)} bytes sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
}

section('§4 the readers — the search corpus and the schema-not-sent hint follow the route')
{
  const searchContext = (model: string, messages: Message[] = [first]) => ({
    messages,
    options: { tools: pool, engineModel: model },
    getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }),
  })
  const QUERY = 'atomic multi-file edit change set'
  const cloud = await ToolSearchTool.call({ query: QUERY, max_results: 5 }, searchContext('claude-sonnet-5') as never)
  const cloudData = (cloud as { data?: { matches?: string[]; total_deferred_tools?: number } }).data ?? (cloud as { matches?: string[]; total_deferred_tools?: number })
  check('a keyword search on a cloud model does not offer ChangeSet (it is already loaded)', !(cloudData.matches ?? []).includes('ChangeSet'), (cloudData.matches ?? []).join(', '))
  const local = await ToolSearchTool.call({ query: QUERY, max_results: 5 }, searchContext(LOCAL) as never)
  const localData = (local as { data?: { matches?: string[]; total_deferred_tools?: number } }).data ?? (local as { matches?: string[]; total_deferred_tools?: number })
  check('the same search on the local lane still offers ChangeSet from the drawer', (localData.matches ?? []).includes('ChangeSet'), (localData.matches ?? []).join(', '))
  check('the cloud drawer counts fewer tools than the local one by exactly the three present', (localData.total_deferred_tools ?? 0) - (cloudData.total_deferred_tools ?? 0) === FULL_NAMES.filter(name => pool.some(tool => tool.name === name)).length, `${localData.total_deferred_tools} vs ${cloudData.total_deferred_tools}`)
  const gitSearch = await ToolSearchTool.call({ query: 'commit staged changes git', max_results: 5 }, searchContext('claude-sonnet-5') as never)
  check('a keyword search on a cloud model now offers Git from the drawer', gitSearch.data.matches.includes('Git'), gitSearch.data.matches.join(', '))
  const selected = await ToolSearchTool.call({ query: 'select:ChangeSet', max_results: 5 }, searchContext('claude-sonnet-5') as never)
  const selectedData = (selected as { data?: { matches?: string[] } }).data ?? (selected as { matches?: string[] })
  check('select:ChangeSet on a cloud model still resolves (the harmless no-op for a loaded tool)', (selectedData.matches ?? []).includes('ChangeSet'))
  process.env.MERCURY_MODEL = 'gpt-5.3-codex'
  check('the schema-not-sent hint stays silent for one of the three on a cloud text form', buildSchemaNotSentHint(ChangeSetTool as unknown as Tool, [first], pool) === null)
  const drawerTool = pool.find(tool => tool.name === stillDeferred[0])
  check(`…and still fires for a tool in the drawer (${stillDeferred[0]})`, drawerTool !== undefined && buildSchemaNotSentHint(drawerTool, [first], pool) !== null)
  check('…and fires for one of the nine on a cloud text form (Git)', buildSchemaNotSentHint(NINE.find(tool => tool.name === 'Git') as Tool, [first], pool) !== null)
  process.env.MERCURY_MODEL = LOCAL
  check('…and fires for one of the three on the local lane', buildSchemaNotSentHint(ChangeSetTool as unknown as Tool, [first], pool) !== null)
  const model = 'gpt-5.3-codex'
  const record = createAttachmentMessage({ type: 'bound_prefix', boundKey: conversationRosterKey('restored', [first], model), rosterEnabled: true, roster: pool.map(tool => ({ name: tool.name, deferred: isDeferredTool(tool) })), sections: [], systemContext: {} })
  const restoredMessages = [first, record]
  check('a restored conversation keeps its recorded deferral in the readers', FULL.every(tool => isDeferredToolFor(tool, model, undefined, restoredMessages)))
  const restoredSearch = await ToolSearchTool.call({ query: QUERY, max_results: 5 }, searchContext(model, restoredMessages) as never)
  check('a restored cloud conversation can still discover ChangeSet by keyword', restoredSearch.data.matches.includes('ChangeSet'), restoredSearch.data.matches.join(', '))
  check('a restored cloud conversation still gets the admission hint', buildSchemaNotSentHint(ChangeSetTool, restoredMessages, pool, model) !== null)
  const restoredDelta = getDeferredToolsDeltaAttachment(pool, model, restoredMessages)[0] as { addedNames?: string[] } | undefined
  check('the restored drawer still announces the three', FULL_NAMES.every(name => restoredDelta?.addedNames?.includes(name)))
  clearToolRosterLatches()
  armToolRosterRestore({ key: record.attachment.boundKey, enabled: true, marks: record.attachment.roster })
  const restoredPlan = await planToolPayload({ model, tools: pool, messages: restoredMessages, latchKey: 'restored', getToolPermissionContext: async () => permissionContext, agents: [] })
  check('the restored plan keeps its original marks', FULL_NAMES.every(name => restoredPlan.deferredNames.has(name)))
  clearToolRosterRestore()
  delete process.env.MERCURY_MODEL
}

section('§5 the gates the twelve keep, and what a late joiner does')
{
  const dap = readFileSync(join(ROOT, 'src', 'services', 'dap', 'dapClient.ts'), 'utf8')
  check('Debug keeps its gate: the catalogue lists it only while an adapter is reachable', /export function isDapToolCatalogEnabled\(\): boolean \{\s*return mercuryDapEnabled\(\) && reachableDapAdapterKeys\(\)\.length > 0/.test(dap))
  const lsp = readFileSync(join(ROOT, 'src', 'tools', 'LSPTool', 'LSPTool.ts'), 'utf8')
  check('the seven language-service tools keep the mount predicate', lsp.includes('isEnabled: isLspToolMounted'))
  const model = 'claude-sonnet-5'
  const initialPool = pool.filter(tool => !MARKED_NAMES.includes(tool.name))
  const joinedPool = [...initialPool, ...FULL, ...NINE]
  const input = { model, messages: [first], latchKey: 'late-loaded', getToolPermissionContext: async () => permissionContext, agents: [] }
  clearToolRosterLatches()
  const initial = await planToolPayload({ ...input, tools: initialPool })
  const joined = await planToolPayload({ ...input, tools: joinedPool })
  check('a late joiner that loads in full stays held rather than deferred and undiscoverable', FULL_NAMES.every(name => !joined.roster.some(tool => tool.name === name) && !joined.deferredNames.has(name) && heldToolsAtLastPlan('late-loaded', [first]).includes(name)))
  check('a late joiner among the nine rides deferred: in the roster, marked, never held', NINE_NAMES.every(name => joined.roster.some(tool => tool.name === name) && joined.deferredNames.has(name) && !heldToolsAtLastPlan('late-loaded', [first]).includes(name)), NINE_NAMES.filter(name => !joined.deferredNames.has(name)).join(', '))
  check('…appended at the end of the frozen list in pool order', joined.roster.slice(-NINE.length).map(tool => tool.name).join(',') === NINE.map(tool => tool.name).join(','), joined.roster.slice(-NINE.length).map(tool => tool.name).join(','))
  check('a late joiner never moves the frozen front of the list', joined.roster.slice(0, initial.roster.length).map(tool => tool.name).join(',') === initial.roster.map(tool => tool.name).join(','))
  const announced = getDeferredToolsDeltaAttachment(joinedPool, model, [first])[0] as { addedNames?: string[] } | undefined
  check('…and is announced on the next turn, while the held three are not', announced !== undefined && NINE_NAMES.every(name => (announced.addedNames ?? []).includes(name)) && FULL_NAMES.every(name => !(announced.addedNames ?? []).includes(name)), announced === undefined ? 'no row' : (announced.addedNames ?? []).join(', '))
  const next = await planToolPayload({ ...input, tools: joinedPool, messages: [createUserMessage({ content: 'new conversation boundary' }) as Message] })
  check('after the boundary the three ride in full and the nine ride deferred, all in pool order at the end', FULL_NAMES.every(name => !next.deferredNames.has(name)) && NINE_NAMES.every(name => next.deferredNames.has(name)) && next.roster.slice(-MARKED_NAMES.length).map(tool => tool.name).join(',') === [...FULL, ...NINE].map(tool => tool.name).join(','))
  check(`the wire form of ${LOCAL} is the text form`, deferralWireFormFor(LOCAL).form === 'text')
  check('ToolSearch itself is never among the twelve', !MARKED_NAMES.includes(TOOL_SEARCH_TOOL_NAME))
}
clearToolRosterLatches()

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
