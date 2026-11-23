#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.HOME = proofHome
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
process.chdir(proofHome)

const BATCH = 70
const AT_ONCE = 5
const PROMPT_BYTES = 200_000
const REPLY_BYTES = 100_000
const KEPT_AFTER_A_BATCH_MB = 4
const MODEL = 'Fixture/Reasoner'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the crewmate batches exceeded 240s; a crewmate turn in runAgent (src/tools/crewmate/runCrewmate.ts) did not end, or the loopback model on 127.0.0.1 stopped answering')
  process.exit(1)
}, 240_000)
guard.unref?.()

const filler = (label: string, bytes: number, salt: string): string => {
  const unit = `${label} ${salt} ${Math.random().toString(36).slice(2)} lorem ipsum dolor sit amet `
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
}

let requests = 0
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/v1/models') return Response.json({ data: [{ id: MODEL, owned_by: 'vllm', max_model_len: 1_048_576 }] })
    if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = (await req.json()) as { model: string }
    requests++
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown): string =>
      `data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    const text = filler('reply', REPLY_BYTES, String(requests))
    let payload = chunk({ reasoning_content: `reasoning-${requests}` })
    for (let at = 0; at < text.length; at += 16_384) payload += chunk({ content: text.slice(at, at + 16_384) })
    payload += chunk({}, 'stop', { prompt_tokens: 2000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 10 } }) + 'data: [DONE]\n\n'
    return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
  },
})
writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({ compatProvider: { boundary: { baseUrl: `http://127.0.0.1:${server.port}/v1`, dialect: 'vllm', models: [MODEL] } } }))
const model = `compat/boundary/${MODEL}`

const config = await import('../../src/platform/settings/config.ts')
config.enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
bootstrap.setOriginalCwd(process.cwd())
bootstrap.setCwdState(process.cwd())
bootstrap.switchSession('00000000-0000-4000-8000-0000000000bb' as never)
const { runAgent } = await import('../../src/tools/crewmate/runCrewmate.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { query: startTurn } = await import('../../src/engine/turnDoor.ts')
const { flushSessionStorage, getAgentTranscript } = await import('../../src/sessions/transcripts/sessionStorage.ts')
await import('../../src/engine/tasks/tasks.ts')

type AppState = import('../../src/screen/app-state/AppStateStore.ts').AppState
let state: AppState = { ...getDefaultAppState(), effortValue: 'low' } as AppState
const setState = (update: (previous: AppState) => AppState): void => {
  state = update(state)
}
const contextOf = (): unknown => ({
  abortController: new AbortController(),
  options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => state,
  setAppState: setState,
  setAppStateForTasks: setState,
  messages: [],
  startTurn,
  readFileState: createFileStateCacheWithSizeLimit(100),
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
})
const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
const definition = { agentType: 'mercury-crew', whenToUse: 'heap fixture', source: 'projectSettings', getSystemPrompt: () => 'Answer at length. Do not call tools.' } as never

async function crewmate(agentId: string): Promise<void> {
  for await (const row of runAgent({
    agentDefinition: definition,
    promptMessages: [createUserMessage({ content: filler('prompt', PROMPT_BYTES, agentId) })],
    toolUseContext: contextOf() as never,
    canUseTool: allow,
    isAsync: true,
    canShowPermissionPrompts: false,
    querySource: 'agent:custom:heap' as never,
    availableTools: [] as never,
    model,
    override: { agentId },
    description: 'heap fixture',
    cwd: process.cwd(),
  } as never)) {
    void row
  }
}

async function batch(name: string, count: number): Promise<void> {
  for (let at = 0; at < count; at += AT_ONCE) {
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, count - at) }, (_, i) => crewmate(`${name}-${String(at + i).padStart(3, '0')}`)))
  }
  await flushSessionStorage()
}

async function heapAfterCollection(): Promise<number> {
  for (let round = 0; round < 3; round++) {
    Bun.gc(true)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return process.memoryUsage().heapUsed
}

const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(1)

console.log('finished crewmates release what they held: a batch that has ended leaves the heap where the batch before it left it')

section(`two batches of ${BATCH} crewmates, ${AT_ONCE} at a time, each with a ${PROMPT_BYTES / 1000} KB prompt and a ${REPLY_BYTES / 1000} KB answer, over a loopback model`)
await batch('warm', AT_ONCE)
await batch('first', BATCH)
const afterFirst = await heapAfterCollection()
await batch('second', BATCH)
const afterSecond = await heapAfterCollection()
const kept = afterSecond - afterFirst

const answered = await getAgentTranscript('second-000' as never)
check(
  `every crewmate ran its turn against the loopback model (${requests} requests) and its transcript is on disk`,
  requests >= 2 * BATCH + AT_ONCE && JSON.stringify(answered?.messages ?? []).includes('reply '),
  `${requests} requests; second-000 has ${answered?.messages.length ?? 0} rows on disk; a crewmate ended before its turn ran or its transcript was not flushed: look at runAgent in src/tools/crewmate/runCrewmate.ts and flushSessionStorage in src/sessions/transcripts/sessionStorage.ts`,
)
check(
  `the second batch of ${BATCH} finished crewmates keeps ${mb(kept)} MB of heap after a collection (${mb(afterFirst)} MB before it, ${mb(afterSecond)} MB after; the ceiling is ${KEPT_AFTER_A_BATCH_MB} MB and may only be lowered)`,
  kept <= KEPT_AFTER_A_BATCH_MB * 1_048_576,
  `${mb(kept)} MB stayed, ${(kept / BATCH / 1024).toFixed(0)} KB a crewmate: something keeps a finished crewmate's messages; find the holder (a store filled per message or per crewmate with nothing that ends it) and release it where the crewmate's run ends, in src/tools/crewmate/runCrewmate.ts or the store's own module; do not raise KEPT_AFTER_A_BATCH_MB`,
)

server.stop(true)
console.log(failures === 0 ? '\n ✅ FINISHED CREWMATES RELEASE THEIR HEAP' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
