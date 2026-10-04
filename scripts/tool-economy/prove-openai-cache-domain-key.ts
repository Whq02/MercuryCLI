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
  console.log('\nTIMEOUT — the openai cache-domain key proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_TOOL_SEARCH',
  'MERCURY_TOOL_DEFER',
  'MERCURY_TOOL_DEFER_PROBE',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_MODEL',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_WIRE_DUMP',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openai-cache-key-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'openai-cache-key-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const MODEL = 'gpt-5.3-codex'
const OTHER_MODEL = 'gpt-6-astra'
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

type Body = Record<string, unknown>
const captured: Body[] = []

const MODELS_BODY = {
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 1_050_000, input_modalities: ['text', 'image'], supported_in_api: true },
    { slug: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 9, context_window: 272_000, input_modalities: ['text'], supported_in_api: true },
  ],
}
function textStream(id: string): string {
  return [
    sse({ type: 'response.created', response: { id } }),
    sse({ type: 'response.output_text.delta', delta: 'done' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
    sse({ type: 'response.completed', response: { id, usage: { input_tokens: 2600, output_tokens: 4, input_tokens_details: { cached_tokens: 2560 } } } }),
  ].join('')
}
let served = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      let body: Body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      } catch {
        body = {}
      }
      captured.push(body)
      served += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(textStream(`resp_${served}`))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}/v1`
process.env.MERCURY_OPENAI_API_BASE = base
process.env.MERCURY_OPENAI_CHATGPT_BASE = base
process.env.MERCURY_OPENAI_AUTH_BASE = base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { composeSystemPrompt } = await import('../../src/prompt/composer.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

function fixtureTool(name: string, opts: { defer?: boolean; params?: string[] } = {}): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of opts.params ?? ['path']) shape[p] = z.string()
  const inputSchema = z.object(shape)
  return {
    name,
    ...(opts.defer ? { shouldDefer: true } : {}),
    prompt: async () => `${name}: a fixture tool with ${Object.keys(shape).join(', ')}`,
    description: async () => `${name} fixture`,
    inputSchema,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => ({ data: 'fixture' }),
  } as unknown as Tool
}
const POOL: Tool[] = ['Read', 'Edit', 'Bash', 'Glob'].map(n => fixtureTool(n))
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

interface Drive {
  errors: string[]
  body: Body | undefined
}
async function drive(messages: Message[], opts: { model?: string; ownerKey: string; tools?: Tool[]; systemPrompt?: string[] }): Promise<Drive> {
  const before = captured.length
  const errors: string[] = []
  try {
    const stream = openaiCallModel({
      messages,
      systemPrompt: (opts.systemPrompt ?? composed()) as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: (opts.tools ?? POOL) as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model: opts.model ?? MODEL,
        isNonInteractiveSession: true,
        querySource: 'main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
        ownerKey: opts.ownerKey,
      } as never,
    } as never)
    for await (const item of stream) {
      const m = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type === 'assistant' && m.isApiErrorMessage) errors.push(JSON.stringify((item as AssistantMessage).message.content).slice(0, 300))
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return { errors, body: captured.slice(before).at(-1) }
}
const keyOf = (d: Drive): string => String(d.body?.prompt_cache_key ?? '(none)')

section('§1 TWO FRESH COMPATIBLE PROCESSES MINT THE SAME KEY — another session id in the environment section, another owner, another first row')
clearToolRosterLatches()
const first = await drive([createUserMessage({ content: 'first process, first turn' }) as Message], { ownerKey: 'owner-one' })
clearToolRosterLatches()
const second = await drive([createUserMessage({ content: 'second process, another first turn' }) as Message], { ownerKey: 'owner-two', systemPrompt: composed({ sessionId: 'session-0002' }) })
{
  check('both processes rode /v1/responses with a prompt_cache_key', first.body !== undefined && second.body !== undefined && typeof first.body.prompt_cache_key === 'string' && typeof second.body.prompt_cache_key === 'string', `${first.errors.join(' | ')} ${second.errors.join(' | ')}`)
  check('the two instructions differ only in the session-class environment section (the scratchpad path)', typeof first.body?.instructions === 'string' && typeof second.body?.instructions === 'string' && first.body.instructions !== second.body.instructions && (first.body.instructions as string).replace('session-0001', 'session-0002') === second.body.instructions)
  check('the tools arrays are byte-identical', JSON.stringify(first.body?.tools) === JSON.stringify(second.body?.tools) && Array.isArray(first.body?.tools))
  check('THE LAW: the two processes mint the SAME prompt_cache_key (the session id never reaches the cache domain)', keyOf(first) === keyOf(second), `${keyOf(first)} vs ${keyOf(second)}`)
  check('the key is the opaque cache-domain digest', /^mercury-domain:[0-9a-f]{24}$/.test(keyOf(first)), keyOf(first))
  clearToolRosterLatches()
  const tail = await drive([createUserMessage({ content: 'third process' }) as Message], { ownerKey: 'owner-three', systemPrompt: composed({ tail: 'gitStatus: M src/calc.ts' }) })
  check('the appended system-context tail (the git status snapshot) never moves the key', keyOf(tail) === keyOf(first), `${keyOf(tail)} vs ${keyOf(first)}`)
}

section('§2 A REAL COMPATIBILITY CHANGE MOVES THE KEY — another model, another roster, another static section')
{
  clearToolRosterLatches()
  const otherModel = await drive([createUserMessage({ content: 'first process, first turn' }) as Message], { ownerKey: 'owner-m', model: OTHER_MODEL })
  check('another model mints another key', otherModel.body !== undefined && keyOf(otherModel) !== keyOf(first), `${keyOf(otherModel)} ${otherModel.errors.join(' | ')}`)
  clearToolRosterLatches()
  const otherRoster = await drive([createUserMessage({ content: 'first process, first turn' }) as Message], { ownerKey: 'owner-r', tools: [...POOL, fixtureTool('Write')] })
  check('another roster mints another key', otherRoster.body !== undefined && keyOf(otherRoster) !== keyOf(first), keyOf(otherRoster))
  clearToolRosterLatches()
  const otherPrompt = await drive([createUserMessage({ content: 'first process, first turn' }) as Message], { ownerKey: 'owner-p', systemPrompt: composed({ intro: 'You are a different fixture assistant. Reply briefly.' }) })
  check('another static section mints another key', otherPrompt.body !== undefined && keyOf(otherPrompt) !== keyOf(first), keyOf(otherPrompt))
}

section('§3 THE CENSUS — the lane mints over the stable-class contract digest')
{
  const lane = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('openaiCallModel mints the key with behaviorContractDigest: stableBehaviourDigest(contract)', /behaviorContractDigest: stableBehaviourDigest\(contract\)/.test(lane))
  check('…and no longer with the whole contract digest (the session-class environment section included)', !/behaviorContractDigest: contract\.digest/.test(lane))
}

server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} OPENAI CACHE-DOMAIN KEY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPENAI CACHE-DOMAIN KEY PROOFS PASS')
process.exit(0)
