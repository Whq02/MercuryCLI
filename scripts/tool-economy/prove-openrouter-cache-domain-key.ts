#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the openrouter cache-domain key proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_MODEL',
  'MERCURY_TOOL_SEARCH',
  'MERCURY_TOOL_DEFER',
  'MERCURY_TOOL_DEFER_PROBE',
  'MERCURY_WIRE_DUMP',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openrouter-cache-key-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'openrouter-cache-key-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const MODEL = 'openrouter/openai/gpt-5-mini'
const WIRE_MODEL = 'openai/gpt-5-mini'
const OTHER_MODEL = 'openrouter/openai/gpt-5-nano'
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

type Body = Record<string, unknown>
interface Capture {
  path: string
  body: Body
}
const captured: Capture[] = []

function responsesTextSse(model: string): string {
  const message = { id: 'msg_fx', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
  return [
    sse({ type: 'response.created', response: { id: 'gen-fx', model, status: 'in_progress' } }),
    sse({ type: 'response.output_item.added', item: { ...message, status: 'in_progress', content: [] } }),
    sse({ type: 'response.output_text.delta', item_id: 'msg_fx', delta: 'done' }),
    sse({ type: 'response.output_item.done', item: message }),
    sse({ type: 'response.completed', response: { id: 'gen-fx', model, status: 'completed', output: [message], usage: { input_tokens: 4310, input_tokens_details: { cached_tokens: 4096 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 4319, cost: 0.00003 } } }),
    'data: [DONE]\n\n',
  ].join('')
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (path === '/api/v1/models') {
        res.end(JSON.stringify({ data: [{ id: WIRE_MODEL, name: 'GPT-5 Mini', context_length: 400000, supported_parameters: ['tools', 'reasoning'] }, { id: 'openai/gpt-5-nano', name: 'GPT-5 Nano', context_length: 400000, supported_parameters: ['tools', 'reasoning'] }] }))
        return
      }
      res.end(JSON.stringify({ data: {} }))
      return
    }
    let body: Body = {}
    try {
      body = JSON.parse(raw) as Body
    } catch {
      body = {}
    }
    captured.push({ path, body })
    if (path === '/api/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesTextSse(String(body.model ?? WIRE_MODEL)))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
process.env.MERCURY_OPENROUTER_API_BASE = `${base}/api/v1`
process.env.MERCURY_OPENROUTER_AUTH_BASE = `${base}/auth`
process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key'
process.env.MERCURY_MODEL = MODEL

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { composeSystemPrompt } = await import('../../src/prompt/composer.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

function fixtureTool(name: string, opts: { defer?: boolean; mcp?: string; params?: string[] } = {}): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of opts.params ?? ['path']) shape[p] = z.string()
  const inputSchema = z.object(shape)
  return {
    name: opts.mcp ? `mcp__${opts.mcp}__${name}` : name,
    ...(opts.mcp ? { isMcp: true, mcpInfo: { serverName: opts.mcp, toolName: name } } : {}),
    ...(opts.defer ? { shouldDefer: true } : {}),
    prompt: async () => `${name}: a fixture tool with ${Object.keys(shape).join(', ')}`,
    description: async () => `${name} fixture`,
    inputSchema,
    ...(opts.mcp ? { inputJSONSchema: { type: 'object', properties: Object.fromEntries(Object.keys(shape).map(k => [k, { type: 'string' }])), required: Object.keys(shape) } } : {}),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => ({ data: 'fixture' }),
  } as unknown as Tool
}
const LOADED = ['Read', 'Edit', 'Bash', 'Glob'].map(n => fixtureTool(n))
const DEFERRED = ['WebFetch', 'NotebookEdit', 'Browser'].map(n => fixtureTool(n, { defer: true, params: ['url', 'count'] }))
const POOL: Tool[] = [...LOADED, ToolSearchTool as never, ...DEFERRED]
const JOINER = fixtureTool('late_tool', { mcp: 'late', params: ['query'] })
const permissionContext = getEmptyToolPermissionContext()
const composed = (opts: { intro?: string; sessionId?: string; tail?: string } = {}): string[] => [
  ...composeSystemPrompt({
    staticSections: [opts.intro ?? 'You are a fixture assistant working in a scratch workspace. Reply briefly.', '# Using your tools\nUse the tools you are given.'],
    dynamicBoundary: [],
    dynamicSpecs: [{ name: 'env_info_simple', cacheBreak: false }],
    dynamicResolved: [`# Environment\n - Primary working directory: /fixture/project\n - Scratchpad directory: /fixture/tmp/${opts.sessionId ?? 'session-0001'}/scratchpad`],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  }),
  opts.tail ?? 'gitStatus: (clean)',
]
const SYSTEM_PROMPT = composed()

interface Drive {
  assistant: AssistantMessage[]
  errors: string[]
  body: Body | undefined
}
async function drive(messages: Message[], opts: { model?: string; ownerKey?: string; tools?: Tool[]; systemPrompt?: string[] } = {}): Promise<Drive> {
  const before = captured.length
  const assistant: AssistantMessage[] = []
  const errors: string[] = []
  try {
    const stream = routedCallModel({
      messages,
      systemPrompt: (opts.systemPrompt ?? SYSTEM_PROMPT) as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: (opts.tools ?? POOL) as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model: opts.model ?? MODEL,
        isNonInteractiveSession: true,
        querySource: 'repl_main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
        ...(opts.ownerKey !== undefined ? { ownerKey: opts.ownerKey } : {}),
      } as never,
    })
    for await (const item of stream) {
      const m = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 300))
      else assistant.push(item as AssistantMessage)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const body = captured.slice(before).find(c => c.path === '/api/v1/responses')?.body
  return { assistant, errors, body }
}
const keyOf = (d: Drive): string => String(d.body?.prompt_cache_key ?? '(none)')
const toolsOf = (d: Drive): string => JSON.stringify(d.body?.tools ?? null)

section('§1 THE KEY IS THE CACHE DOMAIN, NOT THE CONVERSATION — two conversations of one project, model and roster mint the same prompt_cache_key')
clearToolRosterLatches()
const firstRowA = createUserMessage({ content: 'first conversation, first turn' }) as Message
const convA1 = await drive([firstRowA], { ownerKey: 'owner-a' })
const convB1 = await drive([createUserMessage({ content: 'second conversation, another first turn' }) as Message], { ownerKey: 'owner-b' })
{
  check('both conversations rode /api/v1/responses with a prompt_cache_key', convA1.body !== undefined && convB1.body !== undefined && typeof convA1.body.prompt_cache_key === 'string' && typeof convB1.body.prompt_cache_key === 'string', `${convA1.errors.join(' | ')} ${convB1.errors.join(' | ')}`)
  check('the two conversations send byte-identical tools arrays (the shared prefix the provider caches)', toolsOf(convA1) === toolsOf(convB1) && toolsOf(convA1) !== 'null')
  check('the two conversations send byte-identical instructions', convA1.body?.instructions === convB1.body?.instructions && typeof convA1.body?.instructions === 'string')
  check('THE LAW: a different owner and a different first row mint the SAME prompt_cache_key (the shared prefix routes to one cache)', keyOf(convA1) === keyOf(convB1), `${keyOf(convA1)} vs ${keyOf(convB1)}`)
  check('the key names the cache domain (mercury-domain:…), never a conversation digest', keyOf(convA1).startsWith('mercury-domain:'), keyOf(convA1))
  check('the key carries no owner and no session id (an opaque digest of fixed width)', /^mercury-domain:[0-9a-f]{24}$/.test(keyOf(convA1)) && !keyOf(convA1).includes('owner-a'), keyOf(convA1))
}

section('§2 THE KEY HOLDS FOR THE CONVERSATION\'S LIFE — across turns, across a deferred joiner, across a fresh process on the same transcript')
{
  const reply = convA1.assistant as unknown as Message[]
  const convA2 = await drive([firstRowA, ...reply, createUserMessage({ content: 'second turn' }) as Message], { ownerKey: 'owner-a' })
  check('turn 2 of the first conversation carries the same key as turn 1', keyOf(convA2) === keyOf(convA1), `${keyOf(convA2)} vs ${keyOf(convA1)}`)
  const convA3 = await drive([firstRowA, ...reply, createUserMessage({ content: 'third turn' }) as Message], { ownerKey: 'owner-a', tools: [...POOL, JOINER] })
  const joinerRode = (convA3.body?.tools as Array<Record<string, unknown>> | undefined)?.some(t => t.name === JOINER.name && t.defer_loading === true) === true
  check('a deferrable tool that joins the pool mid-conversation rides appended and deferred (withheld from the model upstream)', joinerRode, JSON.stringify((convA3.body?.tools as unknown[] | undefined)?.at(-1) ?? null))
  check('…and the key does not move for it: the loaded definitions are the same, so the cache route is the same', keyOf(convA3) === keyOf(convA1), `${keyOf(convA3)} vs ${keyOf(convA1)}`)
  clearToolRosterLatches()
  const transcript = JSON.parse(JSON.stringify([firstRowA, ...reply, createUserMessage({ content: 'after a restart' })])) as Message[]
  const resumed = await drive(transcript, { ownerKey: 'owner-a-resumed' })
  check('a fresh process resuming the transcript (a JSON round trip, latches cleared, the process owner renewed) mints the same key', keyOf(resumed) === keyOf(convA1), `${keyOf(resumed)} vs ${keyOf(convA1)}`)
}

section('§3 A REAL COMPATIBILITY CHANGE MOVES THE KEY — another model, another loaded roster, another stable prompt')
{
  clearToolRosterLatches()
  const otherModel = await drive([createUserMessage({ content: 'first conversation, first turn' }) as Message], { ownerKey: 'owner-m', model: OTHER_MODEL })
  check('another model mints another key', otherModel.body !== undefined && keyOf(otherModel) !== keyOf(convA1), `${keyOf(otherModel)} ${otherModel.errors.join(' | ')}`)
  clearToolRosterLatches()
  const otherRoster = await drive([createUserMessage({ content: 'first conversation, first turn' }) as Message], { ownerKey: 'owner-r', tools: [...POOL, fixtureTool('Write')] })
  check('another LOADED roster (a non-deferred tool more) mints another key', otherRoster.body !== undefined && keyOf(otherRoster) !== keyOf(convA1), keyOf(otherRoster))
  clearToolRosterLatches()
  const sameLoaded = await drive([createUserMessage({ content: 'first conversation, first turn' }) as Message], { ownerKey: 'owner-d', tools: [...POOL, fixtureTool('Blender', { defer: true })] })
  check('another DEFERRED roster with the same loaded definitions mints the SAME key (deferred definitions never reach the upstream prompt)', sameLoaded.body !== undefined && keyOf(sameLoaded) === keyOf(convA1), `${keyOf(sameLoaded)} vs ${keyOf(convA1)}`)
  clearToolRosterLatches()
  const otherPrompt = await drive([createUserMessage({ content: 'first conversation, first turn' }) as Message], { ownerKey: 'owner-p', systemPrompt: composed({ intro: 'You are a different fixture assistant. Reply briefly.' }) })
  check('another stable system prompt (a static section changed) mints another key', otherPrompt.body !== undefined && keyOf(otherPrompt) !== keyOf(convA1), keyOf(otherPrompt))
  clearToolRosterLatches()
  const otherSession = await drive([createUserMessage({ content: 'first conversation, first turn' }) as Message], { ownerKey: 'owner-s', systemPrompt: composed({ sessionId: 'session-0002' }) })
  check('another SESSION id in the environment section (the scratchpad path) never moves the key: the stable head and the tools still route to one cache', otherSession.body !== undefined && otherSession.body.instructions !== convA1.body?.instructions && keyOf(otherSession) === keyOf(convA1), `${keyOf(otherSession)} vs ${keyOf(convA1)}`)
  clearToolRosterLatches()
  const otherTail = await drive([createUserMessage({ content: 'first conversation, first turn' }) as Message], { ownerKey: 'owner-t', systemPrompt: composed({ tail: 'gitStatus: M src/calc.ts' }) })
  check('the appended system-context tail (the git status snapshot, per session) never moves the key', otherTail.body !== undefined && keyOf(otherTail) === keyOf(convA1), `${keyOf(otherTail)} vs ${keyOf(convA1)}`)
}

section('§4 THE CENSUS — the runtime mints the key through the cache-domain owner and the transport sends nothing else')
{
  const runtime = readFileSync(join(ROOT, 'src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  check('the compat runtime mints the key through mintCacheDomainKey (the one cache-domain owner)', runtime.includes('mintCacheDomainKey({'))
  check('…over the loaded definitions only (a deferred definition is withheld upstream, so it is not part of the cached prefix)', /toolSchemaDigest/.test(runtime) && /deferredNames\.has/.test(runtime))
  const transport = readFileSync(join(ROOT, 'src/services/providers/openrouter/openrouterResponsesTransport.ts'), 'utf8')
  check('the transport sends the minted domain key as prompt_cache_key', /prompt_cache_key: facts\.cacheDomainKey/.test(transport))
  check('the transport no longer digests the conversation key into the route', !transport.includes('openrouterPromptCacheKey'))
}

server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} OPENROUTER CACHE-DOMAIN KEY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPENROUTER CACHE-DOMAIN KEY PROOFS PASS')
process.exit(0)
