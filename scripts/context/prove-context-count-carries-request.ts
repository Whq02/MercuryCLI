#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY',
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_PROVIDER_HEADERS', 'MERCURY_WIRE_DUMP', 'MERCURY_BARE', 'MERCURY_MODEL',
  'MERCURY_EFFORT_LEVEL', 'CLAUDE_EFFORT', 'MERCURY_TOOL_SEARCH',
]) delete process.env[key]
delete process.env.NODE_ENV
delete process.env.ANTHROPIC_BASE_URL
const home = mkdtempSync(join(tmpdir(), 'ctx-count-request-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key'

import { z } from 'zod/v4'
import { countTokensFixtureFigure, startFixtureApi } from '../lib/fixtureApi.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the /context count proof exceeded 180 s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'ctx-count-request-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { ask } = await import('../../src/rows/turn.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { collectContextData } = await import('../../src/commands/context/context-noninteractive.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const { countTokensWithAPI } = await import('../../src/services/tokenEstimation.ts')
const { mcpContentNeedsTruncation, getMaxMcpOutputTokens } = await import('../../src/utils/mcpValidation.ts')

type Body = { system?: unknown; tools?: unknown[]; messages?: Array<{ role: string; content: unknown }> }
type Captured = { path: string; body: Body; raw: string }

function makeStore() {
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
    agentDefinitions: { activeAgents: [], allAgents: [] },
  }
  return {
    getAppState: () => state,
    setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      state = f(state)
    },
  }
}

const tool = {
  name: 'CountProbeTool',
  isMcp: false,
  inputSchema: z.object({ note: z.string().optional() }).passthrough(),
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  checkPermissions: async () => ({ behavior: 'passthrough', message: 'ask the wrapper' }),
  description: async () => 'a count-proof tool',
  prompt: async () => 'A tool the count proof carries so the tools term is not empty.',
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : j(data), tool_use_id: id }),
  call: async () => ({ data: 'ran' }),
}

const api = await startFixtureApi([{ kind: 'text', text: 'THE TURN ANSWERED.' }])
process.env.ANTHROPIC_BASE_URL = api.url
const store = makeStore()
const shared: import('../../src/types/message.ts').Message[] = []
try {
  section('§1 one real turn through the engine, against the fixture API')
  const readCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  const out: Array<Record<string, unknown>> = []
  for await (const msg of ask({
    commands: [],
    prompt: 'Reply once for the count proof.',
    cwd: projDir,
    tools: [tool] as never,
    mcpClients: [],
    canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    getAppState: store.getAppState as never,
    setAppState: store.setAppState as never,
    getReadFileCache: () => readCache,
    setReadFileCache: () => {},
    abortController: new AbortController(),
    mutableMessages: shared,
  })) out.push(msg as Record<string, unknown>)
  const turn = (api.messageRequests() as Captured[]).find(r => !r.path.includes('count_tokens'))
  check('the turn settled with an outcome and one model request on the wire', out.at(-1)?.type === 'outcome' && turn !== undefined, j({ last: out.at(-1)?.type, requests: api.messageRequests().length }))
  check('the turn carried a system block list and the tool', Array.isArray(turn?.body.system) && (turn?.body.system as unknown[]).length >= 2 && (turn?.body.tools ?? []).some(t => (t as { name?: string }).name === 'CountProbeTool'), j({ system: (turn?.body.system as unknown[] | undefined)?.length, tools: turn?.body.tools?.length }))
  check('the session array holds the turn (the write-back landed)', shared.length >= 2 && j(shared).includes('THE TURN ANSWERED.'), `${shared.length} rows`)

  section('§2 /context counts the request the next turn sends: the same system bytes, the same tools bytes')
  const before = api.messageRequests().length
  const model = getEngineModel()
  const data = await collectContextData({
    messages: shared,
    getAppState: store.getAppState as never,
    options: { engineModel: model, tools: [tool] as never, agentDefinitions: { activeAgents: [], allAgents: [] } as never },
  })
  const counts = (api.messageRequests() as Captured[]).slice(before).filter(r => r.path.includes('count_tokens'))
  const withSystem = counts.filter(r => r.body.system !== undefined)
  const request = withSystem.find(r => (r.body.messages ?? []).length > 1)
  const prefix = withSystem.find(r => (r.body.messages ?? []).length === 1 && (r.body.messages ?? [])[0]?.content === 'hi')
  const placeholder = counts.find(r => r.body.system === undefined && (r.body.tools ?? []).length === 0 && (r.body.messages ?? []).length === 1 && (r.body.messages ?? [])[0]?.content === 'hi')
  check('the analysis issued count requests, and exactly two of them carried a system prompt: the request and its prefix', counts.length > 2 && withSystem.length === 2 && request !== undefined && prefix !== undefined, j({ counts: counts.length, withSystem: withSystem.length }))
  check('THE REQUEST COUNT CARRIES THE TURN\'S SYSTEM BLOCKS, BYTE-EQUAL (base: the count carried no system prompt at all)', request !== undefined && turn !== undefined && j(request.body.system) === j(turn.body.system), j({ count: String(j(request?.body.system)).slice(0, 160), turn: String(j(turn?.body.system)).slice(0, 160) }))
  check('…and the turn\'s tools array, byte-equal (the roster without ToolSearch, projected with the same pool)', request !== undefined && turn !== undefined && j(request.body.tools) === j(turn.body.tools), j({ count: String(j(request?.body.tools)).slice(0, 160), turn: String(j(turn?.body.tools)).slice(0, 160) }))
  check('the prefix count carries the same system and tools around the counter\'s placeholder message', prefix !== undefined && request !== undefined && j(prefix.body.system) === j(request.body.system) && j(prefix.body.tools) === j(request.body.tools), j(prefix?.body.messages))
  check('the placeholder count carries neither', placeholder !== undefined)
  const conversation = request !== undefined && turn !== undefined && j(request.body.messages) === j(turn.body.messages)
  console.log(`  evidence: the count\'s messages ${conversation ? 'equal' : 'differ from'} the turn\'s wire messages (${request?.body.messages?.length ?? 0} vs ${turn?.body.messages?.length ?? 0} rows: the count runs after the turn and holds its answer too)`)
  const messagesRow = data.categories.find(c => c.name === 'Messages')?.tokens ?? 0
  const expected = request !== undefined && prefix !== undefined && placeholder !== undefined
    ? Math.max(0, countTokensFixtureFigure(request.raw) - countTokensFixtureFigure(prefix.raw) + countTokensFixtureFigure(placeholder.raw))
    : -1
  check('THE MESSAGES ROW IS THE REQUEST COUNT MINUS ITS PREFIX PLUS THE PLACEHOLDER (the system prompt and the tools taken back out exactly)', expected >= 0 && messagesRow === expected, j({ messagesRow, expected }))
  const sections = counts.filter(r => r.body.system === undefined && (r.body.messages ?? []).length === 1 && (r.body.messages ?? [])[0]?.content !== 'hi')
  check('every per-section and per-tool count still carries no system prompt (they measure one part each)', sections.length > 0 && sections.every(r => r.body.system === undefined), `${sections.length} part counts`)
  check('the System prompt row is still listed by section and counted', (data.systemPromptSections ?? []).length > 1 && data.categories.some(c => c.name === 'System prompt' && c.tokens > 0), j((data.systemPromptSections ?? []).length))

  section('§3 the no-session counters carry no system prompt, deliberately')
  const beforeNoSession = api.messageRequests().length
  const big = 'x '.repeat(getMaxMcpOutputTokens() * 3)
  await mcpContentNeedsTruncation(big)
  const mcpCount = (api.messageRequests() as Captured[]).slice(beforeNoSession).find(r => r.path.includes('count_tokens'))
  check('the MCP truncation gate counts its one message with no system prompt and no tools', mcpCount !== undefined && mcpCount.body.system === undefined && (mcpCount.body.tools ?? []).length === 0 && (mcpCount.body.messages ?? []).length === 1, j({ system: mcpCount?.body.system, tools: mcpCount?.body.tools?.length }))
  const beforeString = api.messageRequests().length
  const stringCount = await countTokensWithAPI('a file body '.repeat(2000))
  const fileCount = (api.messageRequests() as Captured[]).slice(beforeString).find(r => r.path.includes('count_tokens'))
  check('the file-read cap\'s string counter counts one user message with no system prompt', typeof stringCount === 'number' && fileCount !== undefined && fileCount.body.system === undefined && (fileCount.body.messages ?? []).length === 1, j({ stringCount, system: fileCount?.body.system }))
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(projDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`} prove-context-count-carries-request`)
process.exit(failures === 0 ? 0 : 1)
