#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'mcp-list-changed-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_MCP_TIMEOUT_MS = '15000'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_TOOL_SEARCH = '1'
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL', 'MERCURY_HOME', 'NODE_ENV']) delete process.env[k]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the list_changed proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const mcp = await import('../../src/services/mcp/client.ts')
const economy = await import('../../src/services/providers/toolEconomy.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache, clearConversationToolSchemas, getToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { requestDeliberateToolChange } = await import('../../src/services/providers/lawfulPrefixChange.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getToolSchemaDeltaAttachment } = await import('../../src/utils/attachments/toolSchemaDelta.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const FIXTURE = join(ROOT, 'scripts', 'mcp', '_fixture-list-changed-server.mjs')
const stateFile = join(HOME, 'installed.txt')
const NAME = 'media'
const scoped = {
  type: 'stdio',
  command: process.execPath.includes('bun') ? 'node' : process.execPath,
  args: [FIXTURE],
  env: { MCP_FIXTURE_STATE_FILE: stateFile },
  scope: 'local',
} as never
const MODEL = 'claude-fable-5-1'
const ctxFor = (pool: Tool[]): unknown => ({ options: { engineModel: MODEL, tools: pool, agentDefinitions: { activeAgents: [] } }, getAppState: () => ({ ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext() }), agentId: undefined })
const { rosterOwnerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const owner = String(rosterOwnerFromToolUseContext(ctxFor([]) as never))
const first = createUserMessage({ content: 'Generate a swatch.' }) as unknown as Message
const enumOf = (definition: unknown): string[] => ((definition as { input_schema?: { properties?: { model?: { enum?: string[] } } } } | undefined)?.input_schema?.properties?.model?.enum ?? [])
const nameOf = (tool: { name: string }): string => tool.name
const permission = async () => getEmptyToolPermissionContext()
const render = (tool: Tool, plan: Awaited<ReturnType<typeof economy.planToolPayload>>) =>
  toolToAPISchema(tool, { getToolPermissionContext: permission, tools: plan.roster, agents: [], model: MODEL, conversationKey: plan.conversationKey, deferLoading: plan.deferredNames.has(tool.name), bound: plan.isBound(tool.name) })
const plan = (pool: Tool[], messages: Message[]) =>
  economy.planToolPayload({ model: MODEL, tools: pool, messages, latchKey: owner, getToolPermissionContext: permission, agents: [], source: 'prove' })

try {
  section("§1 the SDK's own server over stdio, through production's connect: the first tools/list is the server's opening shape")
  const connected = await mcp.reconnectMcpServerImpl(NAME, scoped)
  const client = connected.client
  check('the server connected and advertises tools/list_changed', client.type === 'connected' && (client as { capabilities?: { tools?: { listChanged?: boolean } } }).capabilities?.tools?.listChanged === true, j(client.type === 'connected' ? (client as { capabilities?: unknown }).capabilities : client))
  if (client.type !== 'connected') throw new Error('no connection')
  const v1 = await mcp.fetchToolsForClient(client)
  const generateName = v1.map(nameOf).find(name => name.endsWith('__image_generate'))!
  const modelsName = generateName.replace('image_generate', 'media_models')
  check('the opening tool list carries image_generate with two models and no media_models', generateName !== undefined && !v1.map(nameOf).includes(modelsName) && j((v1.find(tool => tool.name === generateName) as { inputJSONSchema?: unknown })?.inputJSONSchema).includes('flux2-klein-4b') && !j((v1.find(tool => tool.name === generateName) as { inputJSONSchema?: unknown })?.inputJSONSchema).includes('qwen-image-21'), j(v1.map(nameOf)))

  section('§2 the conversation froze its roster on the opening shape; then the server installs a model and announces tools/list_changed')
  clearToolSchemaCache()
  clearConversationToolSchemas()
  economy.clearToolRosterLatches()
  const poolV1: Tool[] = [ToolSearchTool as never, ...v1]
  const messages: Message[] = [first]
  const p1 = await plan(poolV1, messages)
  const sentGenerate = await render(v1.find(tool => tool.name === generateName)!, p1)
  check('the first request lists image_generate deferred with the two models', p1.deferredNames.has(generateName) && j(enumOf(sentGenerate)) === j(['z-image-turbo', 'flux2-klein-4b']), j(sentGenerate))

  let refetched: Tool[] | null = null
  let fired = 0
  const landed = new Promise<void>(resolve => {
    mcp.onMcpListChanged(client.client, 'tools', () => {
      fired++
      void (async () => {
        mcp.fetchToolsForClient.cache.delete(client.name)
        refetched = await mcp.fetchToolsForClient(client)
        requestDeliberateToolChange(owner, refetched, `the MCP server ${client.name} changed its tools`)
        resolve()
      })()
    })
  })
  const installed = await client.client.callTool({ name: 'install_model', arguments: { name: 'qwen-image-21' } })
  check('the install ran on the server', j(installed.content).includes('installed qwen-image-21'), j(installed.content))
  await Promise.race([landed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('no tools/list_changed within 10s')), 10_000))])
  check("Mercury's listener heard the notification and re-read the server's tools", fired >= 1 && refetched !== null, `fired ${fired}`)
  const v2 = refetched as unknown as Tool[]
  check('the re-read carries media_models and the three-model image_generate', v2.map(nameOf).includes(modelsName) && j((v2.find(tool => tool.name === generateName) as { inputJSONSchema?: unknown })?.inputJSONSchema).includes('qwen-image-21'), j(v2.map(nameOf)))
  check('the rendered definitions were cleared so the refreshed server is read afresh', getToolSchemaCache().size === 0)

  section('§3 the next request, same conversation: the new tool joins deferred, and the unreferenced deferred tool takes its new input on the wire — nothing bound moved, no restart')
  const poolV2: Tool[] = [ToolSearchTool as never, ...v2]
  const p2 = await plan(poolV2, messages)
  check('the roster keeps its order and appends media_models at the end, deferred', j(p2.roster.map(nameOf).slice(0, p1.roster.length)) === j(p1.roster.map(nameOf)) && p2.roster.map(nameOf).at(-1) === modelsName && p2.deferredNames.has(modelsName), j(p2.roster.map(nameOf)))
  check('image_generate, listed but never referenced, is unbound', p2.isBound(generateName) === false)
  const liveGenerate = await render(v2.find(tool => tool.name === generateName)!, p2)
  check('image_generate goes out with the three models at once (an unreferenced deferred tool is outside the bound prefix)', j(enumOf(liveGenerate)) === j(['z-image-turbo', 'flux2-klein-4b', 'qwen-image-21']), j(liveGenerate))
  const noDelta = await getToolSchemaDeltaAttachment(ctxFor(poolV2) as never, messages)
  check('no schema delta row for a tool whose live definition already rides the wire', noDelta.length === 0, j(noDelta))

  section('§4 a conversation that had already loaded image_generate through ToolSearch: its sent definition holds, and the new input reaches the model on a new row')
  clearConversationToolSchemas()
  economy.clearToolRosterLatches()
  const referenced: Message[] = [
    first,
    { type: 'assistant', uuid: '00000000-0000-4000-a000-000000000011', timestamp: new Date().toISOString(), message: { id: 'msg_search', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: 'toolu_search', name: 'ToolSearch', input: { query: `select:${generateName}` } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } as never,
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_search', content: [{ type: 'tool_reference', tool_name: generateName }] as never }] }) as unknown as Message,
  ]
  const r1 = await plan(poolV1, referenced)
  const boundSent = await render(v1.find(tool => tool.name === generateName)!, r1)
  check('the loaded tool was sent with two models', j(enumOf(boundSent)) === j(['z-image-turbo', 'flux2-klein-4b']))
  const r2 = await plan(poolV2, referenced)
  check('image_generate, referenced, is bound', r2.isBound(generateName) === true)
  const boundAgain = await render(v2.find(tool => tool.name === generateName)!, r2)
  check('the wire keeps the definition the conversation was sent (two models): the bound prefix never moves', j(enumOf(boundAgain)) === j(['z-image-turbo', 'flux2-klein-4b']), j(boundAgain))
  const delta = await getToolSchemaDeltaAttachment(ctxFor(poolV2) as never, referenced)
  const deltaRow = delta[0] as { type: string; tools?: Array<{ name: string }>; body?: string } | undefined
  check('the schema delta row names image_generate with the three models, so the model can ask for qwen-image-21 without a restart', delta.length === 1 && deltaRow?.type === 'tool_schema_delta' && j(deltaRow.tools?.map(t => t.name)) === j([generateName]) && (deltaRow.body ?? '').includes('qwen-image-21'), j(delta))
  const result = await client.client.callTool({ name: 'image_generate', arguments: { prompt: 'a rune', model: 'qwen-image-21' } })
  check('a call with the new model name is accepted by the server', j(result.content).includes('with qwen-image-21'), j(result.content))

  section('§5 /mcp reconnect for a server that does not announce: the reconnected server starts with the installed model and its tools are read afresh')
  await mcp.clearServerCache(NAME, scoped)
  const again = await mcp.reconnectMcpServerImpl(NAME, scoped)
  check('the reconnect landed with the three-model image_generate and media_models', again.client.type === 'connected' && again.tools.map(nameOf).includes(modelsName) && j((again.tools.find(tool => tool.name === generateName) as { inputJSONSchema?: unknown })?.inputJSONSchema).includes('qwen-image-21'), j(again.tools.map(nameOf)))
  if (again.client.type === 'connected') await again.client.client.close().catch(() => {})
} finally {
  await mcp.clearServerCache(NAME, scoped).catch(() => {})
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'mcp-list-changed-live: GREEN' : `mcp-list-changed-live: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
