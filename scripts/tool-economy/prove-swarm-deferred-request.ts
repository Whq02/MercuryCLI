#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../src/Tool.ts'
import type { Message, AssistantMessage } from '../../src/types/message.ts'
import type { Attachment } from '../../src/utils/attachments/types.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['NODE_ENV', 'MERCURY_BARE', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_AUTH_SCOPE_DIR']) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
process.env.MERCURY_DAEMON_DIR = join(proofHome, 'daemon')
let failures = 0
const check = (label: string, ok: boolean): void => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`); if (!ok) failures++ }
const model = 'gpt-6-luna'
type Item = Record<string, any>
const captures: Item[] = []
const searches: Item[] = []
const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.split('?')[0]?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [{ slug: model, display_name: 'Fixture Luna', supported_reasoning_levels: [{ effort: 'max', description: 'max' }], default_reasoning_level: 'max', visibility: 'list', context_window: 1_050_000, supported_in_api: true }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Item
  captures.push(body)
  const n = captures.length
  const items: Item[] = []
  if (n === 1) {
    const loaded = body.tools.filter((t: Item) => t.defer_loading && ['CrewBoard', 'LoadedFixture'].includes(t.name))
    searches.push(
      { type: 'tool_search_call', id: 'search_1', execution: 'server', call_id: null, status: 'completed', arguments: { paths: loaded.map((t: Item) => t.name) } },
      { type: 'tool_search_output', id: 'loaded_1', execution: 'server', call_id: null, status: 'completed', tools: loaded },
    )
    items.push(...searches)
  }
  if (n > 3) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      sse({ type: 'response.output_text.delta', delta: 'Finished.' }),
      sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished.' }] } }),
      sse({ type: 'response.completed', response: { id: `response_${n}`, usage: { input_tokens: 2600, output_tokens: 4, input_tokens_details: { cached_tokens: 2400 } } } }),
    ].join(''))
    return
  }
  items.push({ type: 'function_call', id: `fc_${n}`, call_id: `post_${n}`, name: 'CrewBoard', arguments: JSON.stringify({ op: 'post', kind: 'result', clientOpId: `post_${n}`, text: `fixture #${n}` }) })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end([
    sse({ type: 'response.created', response: { id: `response_${n}` } }),
    ...items.map(item => sse({ type: 'response.output_item.done', item })),
    sse({ type: 'response.completed', response: { id: `response_${n}`, usage: { input_tokens: 2600, output_tokens: 40, input_tokens_details: { cached_tokens: n === 1 ? 0 : 2400 } } } }),
  ].join(''))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const host = `127.0.0.1:${address.port}`
for (const key of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE']) process.env[key] = `http://${host}/v1`
const workspace = join(proofHome, 'workspace')
mkdirSync(workspace)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(workspace)
bootstrap.setCwdState(workspace)
bootstrap.setProjectRoot(workspace)
bootstrap.setSessionTrustAccepted(true)
bootstrap.setIsInteractive(false)
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const seam = await import('../../src/services/crewBoard/seam.ts')
runSwarmCommand('on')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { getAttachments, createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
const { planToolPayload, clearToolRosterLatches, toolRosterLatchFor } = await import('../../src/services/providers/toolEconomy.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { recordGatewayProbe, openaiGatewayProbeKey } = await import('../../src/services/providers/deferralProbe.ts')
recordGatewayProbe(openaiGatewayProbeKey(host), { verdict: 'openai-native', status: 200, evidence: 'loopback fixture serves native search', probedAt: new Date().toISOString() })
const fixture = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name, shouldDefer: true, inputSchema: z.object({ value: z.string() }),
  prompt: async () => 'Fixture tool', description: async () => 'Fixture tool',
  isEnabled: () => true, isReadOnly: () => true, isConcurrencySafe: () => true,
  userFacingName: () => name, call: async () => ({ data: 'fixture' }), ...extra,
}) as Tool
const loaded = fixture('LoadedFixture')
const pending = fixture('PendingFixture')
let appState = getDefaultAppState()
const { assembleToolPool } = await import('../../src/tools.ts')
const availableTools = [...assembleToolPool(appState.toolPermissionContext, []), loaded, pending] as Tool[]
let pool: Tool[] = []
const context = (tools: Tool[], messages: Message[], agentId = 'fixture-seat', engineModel = model): ToolUseContext => ({
  agentId,
  options: { commands: [], tools, engineModel, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  abortController: new AbortController(), messages, readFileState: createFileStateCacheWithSizeLimit(100),
  loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(),
}) as unknown as ToolUseContext
const collect = (tools: Tool[], messages: Message[], agentId?: string, engineModel?: string) => getAttachments(null, context(tools, messages, agentId, engineModel), [], messages, undefined, { localSubmission: true })
const deltas = (rows: Attachment[]) => rows.filter((row): row is Extract<Attachment, { type: 'deferred_tools_delta' }> => row.type === 'deferred_tools_delta')
const plan = (tools: Tool[], messages: Message[], agentId: string, engineModel = model) => planToolPayload({ model: engineModel, tools, messages, latchKey: String(processOwnerForLane(agentId)), agents: [], getToolPermissionContext: async () => appState.toolPermissionContext })
const messages: Message[] = [createUserMessage({ content: 'Post three results.' })]
const parent = context(availableTools, messages)
delete parent.agentId
parent.options.thinkingConfig = { type: 'enabled', budgetTokens: 10000 }
Object.assign(parent, { setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {} })
const definition = { agentType: 'mercury-crew', whenToUse: 'Fixture', source: 'projectSettings', getSystemPrompt: () => 'Post three results.' }
for await (const reply of runAgent({
  agentDefinition: definition as never, promptMessages: messages.slice(), toolUseContext: parent,
  canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never,
  isAsync: true, querySource: 'agent:builtin:mercury-crew', availableTools, model, effortOverride: 'max',
  override: { agentId: 'fixture-seat', userContext: {}, systemContext: {} },
  name: 'fixture-seat', cwd: workspace,
  onCacheSafeParams: params => { pool = [...params.toolUseContext.options.tools] },
})) messages.push(reply)
const board = pool.find(tool => tool.name === 'CrewBoard')!
const replies = messages.filter((message): message is AssistantMessage => message.type === 'assistant')
check('the fresh launch settles four requests without an API error', captures.length === 4 && replies.length > 0 && replies.every(reply => !reply.isApiErrorMessage))
check('the launch starts with main’s deferred instance and never mutates it', availableTools.find(tool => tool.name === 'CrewBoard')?.alwaysLoad !== true)
for (let turn = 1; turn <= 3; turn++) {
  const body = captures[turn - 1]!
  check(`request ${turn}: CrewBoard has its full schema with no defer_loading mark`, body.tools.some((tool: Item) => tool.name === 'CrewBoard' && tool.parameters && tool.defer_loading === undefined))
  check(`request ${turn}: max effort and the selected model ride unchanged`, body.model === model && body.reasoning?.effort === 'max')
  if (turn > 1) {
    check(`request ${turn}: the loaded search output replays verbatim`, searches.every(item => body.input.some((candidate: Item) => JSON.stringify(candidate) === JSON.stringify(item))))
    check(`request ${turn}: tool array and cache key match request 1`, JSON.stringify(body.tools) === JSON.stringify(captures[0]!.tools) && body.prompt_cache_key === captures[0]!.prompt_cache_key)
  }
  const output = captures[turn]!.input.find((item: Item) => item.type === 'function_call_output' && item.call_id === `post_${turn}`)
  check(`request ${turn}: the real board accepts the direct post and its result replays`, output !== undefined && JSON.parse(output.output).ok === true)
}
check('no request announces the loaded CrewBoard as deferred', captures.every(body => body.input.every((item: Item) => !JSON.stringify(item.content ?? '').match(/not loaded[^]*\\nCrewBoard(?:\\n| —)/))))
const unannounced = messages.filter(message => message.type !== 'attachment' || message.attachment.type !== 'deferred_tools_delta')
check('a late notice omits called and server-loaded tools even without an earlier announcement', deltas(await collect(pool, unannounced)).every(row => !row.addedNames.includes(board.name) && !row.addedNames.includes(loaded.name)))
check('usage settles the cached prefix', replies.at(-1)?.message.usage.cache_read_input_tokens === 2400)
console.log('CAPTURE ' + JSON.stringify({ endpoint: `http://${host}/v1/responses`, accountKind: 'api-key fixture', selectedModel: model, servedModel: model, requests: captures }))
const joined = fixture('mcp__joined__echo', { isMcp: true } as Partial<Tool>)
const later = await collect([...pool, joined], messages)
check('an MCP tool joining after the replies is announced exactly once', JSON.stringify(deltas(later).map(row => row.addedNames)) === JSON.stringify([[joined.name]]))
messages.push(...later.map(createAttachmentMessage))
check('the next collection repeats no MCP announcement', deltas(await collect([...pool, joined], messages)).length === 0)
const current = await plan([...pool, joined], messages, 'fixture-seat')
check('the MCP join appends one deferred tool without changing existing marks', current.deferredNames.has(joined.name) && !current.deferredNames.has(board.name) && current.roster.at(-1)?.name === joined.name)
const fullMessages = [createUserMessage({ content: 'Full roster.' })] as Message[]
process.env.MERCURY_TOOL_SEARCH = '0'
await plan(pool, fullMessages, 'full-seat')
delete process.env.MERCURY_TOOL_SEARCH
fullMessages.push(createAssistantMessage({ content: 'Continue.' }))
check('a conversation latched in full is not falsely announced after the mode changes', deltas(await collect(pool, fullMessages, 'full-seat')).length === 0)
const original = toolRosterLatchFor(String(processOwnerForLane('full-seat')), fullMessages, model)
check('announcement collection never rewrites the full roster latch', original?.enabled === false && original.deferred.size === 0)
const callsOnly = [createUserMessage({ content: 'Already called.' }), createAssistantMessage({ content: [{ type: 'tool_use', id: 'called', name: pending.name, input: { value: 'x' } }] })] as Message[]
check('a called tool without a search record is never announced as unloaded', deltas(await collect(pool, callsOnly, 'called-seat')).every(row => !row.addedNames.includes(pending.name)))
for (const engineModel of ['claude-sonnet-5-5', model, 'gpt-5.3-codex', 'openrouter/qwen/qwen3-coder', 'glm-5.3', 'kimi-for-coding', 'deepseek-flash', 'gemini-3-pro', 'local/qwen3-32b', 'compat/qwen-max']) {
  const fresh = [createUserMessage({ content: 'Fresh roster.' })] as Message[]
  const planned = await plan(pool, fresh, `road-${engineModel}`, engineModel)
  check(`${engineModel}: a swarm seat has CrewBoard loaded in full`, planned.roster.some(tool => tool.name === board.name) && !planned.deferredNames.has(board.name))
}
const leadBoard = seam.swarmTools()[0]!
const leadMessages = [createUserMessage({ content: 'Start without a board.' })] as Message[]
await plan([ToolSearchTool, pending], leadMessages, 'main')
const lateLead = await plan([ToolSearchTool, pending, leadBoard], leadMessages, 'main')
check('main keeps its deferred board and a late join remains callable through search', lateLead.deferredNames.has(leadBoard.name) && lateLead.roster.some(tool => tool.name === leadBoard.name))
const oldSeatMessages = [createUserMessage({ content: 'An existing seat roster.' })] as Message[]
await plan([ToolSearchTool, { ...board, alwaysLoad: false }, pending], oldSeatMessages, 'old-seat')
const oldSeat = await plan([ToolSearchTool, board, pending], oldSeatMessages, 'old-seat')
check('an existing seat keeps its deferred mark rather than changing its cache prefix', oldSeat.deferredNames.has(board.name))
const { restoreBoundPrefixFromMessages } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { conversationRosterKey, clearToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
for (const enabled of [true, false]) {
  clearToolRosterLatches()
  clearToolRosterRestore()
  const agentId = `resumed-${enabled}`
  const first = createUserMessage({ content: 'Resume the recorded roster.' })
  const record = createAttachmentMessage({
    type: 'bound_prefix',
    boundKey: conversationRosterKey(String(processOwnerForLane(agentId)), [first], model),
    rosterEnabled: enabled,
    roster: [{ name: 'ToolSearch', deferred: false }, { name: loaded.name, deferred: false }, { name: pending.name, deferred: enabled }],
    sections: [], systemContext: {},
  })
  const restored = [first, record, createAssistantMessage({ content: 'Earlier reply.' })] as Message[]
  restoreBoundPrefixFromMessages(restored, { rosterOnly: true })
  const restoredTools = [ToolSearchTool, loaded, pending, joined] as Tool[]
  const notice = deltas(await collect(restoredTools, restored, agentId)).flatMap(row => row.addedNames).sort()
  check(`resume with deferral ${enabled}: collection does not seed the request latch`, toolRosterLatchFor(String(processOwnerForLane(agentId)), restored, model) === undefined)
  const planned = await plan(restoredTools, restored, agentId)
  check(`resume with deferral ${enabled}: the first notice follows the recorded roster and its MCP join`, JSON.stringify(notice) === JSON.stringify(enabled ? [pending.name, joined.name].sort() : []))
  check(`resume with deferral ${enabled}: collection preserves the request's saved enablement and full tool`, planned.enabled === enabled && !planned.deferredNames.has(loaded.name) && planned.roster.some(tool => tool.name === loaded.name))
}
clearToolRosterLatches()
clearToolRosterRestore()
seam.swarmStore()?.close()
server.close()
console.log(`swarm deferred requests: ${failures} failures`)
process.exit(failures ? 1 : 0)
