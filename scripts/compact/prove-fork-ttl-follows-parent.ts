#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
delete process.env.NODE_ENV
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_EFFORT_LEVEL', 'MERCURY_PROMPT_CACHING', 'MERCURY_CACHE_TTL', 'MERCURY_CREW_AGENT', 'MERCURY_DAEMON_PERMISSION_MODE']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fork-ttl-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key'
process.env.MERCURY_CACHE_CLOCK = '0'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the fork TTL prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi(
  Array.from({ length: 8 }, (_, i) => ({ kind: 'text' as const, text: `fixture reply ${i + 1}` })),
)
process.env.ANTHROPIC_BASE_URL = api.url

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { runForkedAgent } = await import('../../src/utils/forkedAgent.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

const MODEL = 'claude-opus-4-8'
const PARENT_SOURCE = 'repl_main_thread'
const posture = asSystemPrompt(['You are a fixture-driven session posture.'])

let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function assistantRow(text: string): unknown {
  const id = `msg_${nextUuid().slice(-6)}`
  return {
    type: 'assistant',
    uuid: nextUuid(),
    requestId: `req_${id}`,
    timestamp: new Date().toISOString(),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
}
const messages: unknown[] = [
  createUserMessage({ content: 'please bump the version and run the tests' }),
  assistantRow('Bumped the version and ran the suite — all green.'),
  createUserMessage({ content: 'now write the changelog entry' }),
]

function makeContext(): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: {
      tools: [],
      mcpClients: [],
      mainLoopModel: MODEL,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}

type Body = {
  system?: Array<{ cache_control?: { type?: string; ttl?: string } }>
  messages?: Array<{ role: string; content: unknown }>
}
function markersOf(body: Body): { system: Array<string | null>; message: string | null | 'none' } {
  const system = (body.system ?? []).filter(b => b.cache_control !== undefined).map(b => b.cache_control?.ttl ?? null)
  let message: string | null | 'none' = 'none'
  for (const row of body.messages ?? []) {
    if (!Array.isArray(row.content)) continue
    for (const block of row.content as Array<{ cache_control?: { ttl?: string } }>) {
      if (block.cache_control !== undefined) message = block.cache_control.ttl ?? null
    }
  }
  return { system, message }
}
const lastBody = (from: number): Body => (api.messageRequests().slice(from).at(-1)?.body ?? {}) as Body

async function parentRequest(): Promise<Body> {
  const from = api.messageRequests().length
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const stream = routedCallModel({
    messages: messages as never,
    systemPrompt: posture,
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: () => Promise.resolve(toolPermissionContext),
      model: MODEL,
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      querySource: PARENT_SOURCE,
      agents: [],
      mcpTools: [],
    },
  } as never)
  for await (const _event of stream) {
  }
  return lastBody(from)
}

async function forkRequest(querySource: string): Promise<Body> {
  const from = api.messageRequests().length
  const ctx = makeContext()
  await runForkedAgent({
    promptMessages: [createUserMessage({ content: 'Summarise the conversation so far in one line.' })],
    cacheSafeParams: {
      systemPrompt: posture,
      userContext: {},
      systemContext: {},
      toolUseContext: ctx as never,
      forkContextMessages: messages as never,
    },
    canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never,
    querySource: querySource as never,
    forkLabel: 'compact',
    maxTurns: 1,
    skipCacheWrite: true,
    skipTranscript: true,
  })
  return lastBody(from)
}

const allWord = (system: Array<string | null>, word: string | null): boolean => system.length >= 1 && system.every(ttl => ttl === word)

section('§1 default lifetimes match across query sources')
{
  bootstrap.setPromptCache1hEligible(true)

  const parent = markersOf(await parentRequest())
  check('parent markers use the default lifetime', allWord(parent.system, null) && parent.message === null, j(parent))

  const fork = markersOf(await forkRequest('compact'))
  check('compaction markers use the same default lifetime', allWord(fork.system, null) && fork.message === null, j(fork))
  check('…and its markers are present (a marker on the shared prefix, not a request without one)', fork.system.length === parent.system.length && fork.message !== 'none', j({ fork, parent }))

  const control = markersOf(await forkRequest('session_memory'))
  check('a different query source also uses the default lifetime', allWord(control.system, null) && control.message === null, j(control))
}

section('§2 an explicit one-hour lifetime applies to every request')
{
  process.env.MERCURY_CACHE_CLOCK = '1'
  process.env.MERCURY_CACHE_TTL = '1h'

  const parent = markersOf(await parentRequest())
  check("the parent's request carries the clock's word (ttl:'1h') on every marker", allWord(parent.system, '1h') && parent.message === '1h', j(parent))
  const fork = markersOf(await forkRequest('compact'))
  check("the compaction request carries the clock's word too", allWord(fork.system, '1h') && fork.message === '1h', j(fork))
  const unnamed = markersOf(await forkRequest('session_memory'))
  check("the other query source carries the same clock-selected lifetime", allWord(unnamed.system, '1h') && unnamed.message === '1h', j(unnamed))
}

await api.close()
console.log(`\n${failures === 0 ? 'FORK TTL FOLLOWS PARENT: GREEN' : `FORK TTL FOLLOWS PARENT: ${failures} FAILURE(S)`} (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
