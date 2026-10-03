#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qe-laws-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

import { z } from 'zod/v4'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'qe-laws-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { ask } = await import('../../src/rows/turn.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import(
  '../../src/utils/fileStateCache.ts'
)

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
  console.log('\n❌ TIMEOUT — the turn laws proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()


function makeStore(): {
  getAppState: () => Record<string, unknown>
  setAppState: (f: (prev: Record<string, unknown>) => Record<string, unknown>) => void
} {
  let state: Record<string, unknown> = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    fileHistory: { snapshots: new Map(), fileVersions: new Map() },
    attribution: {},
  }
  return {
    getAppState: () => state,
    setAppState: f => {
      state = f(state)
    },
  }
}

function makeFakeTool(over: { name?: string } = {}): Record<string, unknown> {
  const name = over.name ?? 'QeProbeTool'
  return {
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    checkPermissions: async () => ({ behavior: 'passthrough', message: 'ask the wrapper' }),
    description: async () => 'probe tool',
    prompt: async () => 'probe tool prompt',
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: async () => ({ data: 'probe tool ran' }),
  }
}

type SdkMsg = Record<string, unknown> & { type: string; status?: string }

async function runAsk(opts: {
  turns: ScriptedTurn[]
  prompt?: string
  tools?: Array<Record<string, unknown>>
  canUseTool?: (...a: unknown[]) => Promise<unknown>
  customSystemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  abortAfterFirstRequest?: boolean
  mutableMessages?: import('../../src/types/message.ts').Message[]
}): Promise<{ api: FixtureApi; out: SdkMsg[]; cacheWrittenBack: unknown }> {
  const api = await startFixtureApi(opts.turns)
  process.env.ANTHROPIC_BASE_URL = api.url
  const store = makeStore()
  const readCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  let cacheWrittenBack: unknown
  const abortController = new AbortController()
  if (opts.abortAfterFirstRequest) {
    void api.messageRequestStarted(1).then(() => abortController.abort())
  }
  const out: SdkMsg[] = []
  try {
    for await (const msg of ask({
      commands: [],
      prompt: opts.prompt ?? 'Reply once.',
      cwd: projDir,
      tools: (opts.tools ?? []) as never,
      mcpClients: [],
      canUseTool: (opts.canUseTool ??
        (async () => ({ behavior: 'allow', updatedInput: {} }))) as never,
      getAppState: store.getAppState as never,
      setAppState: store.setAppState as never,
      getReadFileCache: () => readCache,
      setReadFileCache: c => {
        cacheWrittenBack = c
      },
      customSystemPrompt: opts.customSystemPrompt,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      abortController,
      ...(opts.mutableMessages !== undefined ? { mutableMessages: opts.mutableMessages } : {}),
    })) {
      out.push(msg as SdkMsg)
    }
  } finally {
    await api.close()
  }
  return { api, out, cacheWrittenBack }
}

console.log('============================================================')
console.log(' the turn / ask() — the row-stream session laws')
console.log('============================================================')

section('Q1 — row order · stop word capture · usage accumulation · last-TEXT answer')
{
  const { api, out, cacheWrittenBack } = await runAsk({
    turns: [{ kind: 'text', text: 'Q1 SCRIPTED ANSWER.' }],
  })
  check('the FIRST row opens the turn (turn · started)', out[0]?.type === 'turn' && out[0]?.state === 'started', j(out[0]?.type))
  const text = out.find(m => m.type === 'text')
  check('a text row carries the scripted text', !!text && text.text === 'Q1 SCRIPTED ANSWER.')
  const step = out.find(m => m.type === 'step') as (SdkMsg & { usage?: { output_tokens?: number }; stop?: string }) | undefined
  check('one step row names the model call with its usage and stop word', step !== undefined && step.usage?.output_tokens === 12 && step.stop === 'end_turn', j(step))
  const result = out.at(-1) as SdkMsg & {
    answer?: string
    stop?: string
    usage?: { output_tokens?: number }
    steps?: number
  }
  check('the LAST row is the completed outcome', result?.type === 'outcome' && result?.status === 'completed', j({ t: result?.type, s: result?.status }))
  check('outcome.answer is the scripted text (last TEXT block)', result?.answer === 'Q1 SCRIPTED ANSWER.', result?.answer)
  check("the stop word is the message_delta-captured 'end_turn'", result?.stop === 'end_turn', String(result?.stop))
  check('usage accumulated from the stream (fixture output_tokens=12)', result?.usage?.output_tokens === 12, j(result?.usage))
  check('one step counted on the clean path', result?.steps === 1, String(result?.steps))
  check('exactly one model call', api.messageRequests().length === 1, `${api.messageRequests().length}`)
  check('Q6: ask() writes the read cache back in finally', cacheWrittenBack !== undefined && typeof (cacheWrittenBack as { dump?: unknown }).dump === 'function')
}

section('Q7 — the seat’s memory: ONE shared array across ask() calls carries the conversation (the amnesia concession)')
{
  type Msg = import('../../src/types/message.ts').Message
  const shared: Msg[] = []
  const first = await runAsk({
    turns: [{ kind: 'text', text: 'THE FIRST ANSWER.' }],
    prompt: 'my name is Ozymandias',
    mutableMessages: shared,
  })
  const firstResult = first.out.at(-1) as SdkMsg
  check('turn 1 settles clean', firstResult?.type === 'outcome' && firstResult?.status === 'completed', j({ t: firstResult?.type, s: firstResult?.status }))
  check(
    'the write-back landed: after turn 1 the shared array holds the prompt AND the reply',
    shared.length >= 2 && j(shared).includes('my name is Ozymandias') && j(shared).includes('THE FIRST ANSWER.'),
    `${shared.length} frames`,
  )
  const hostFrame = {
    type: 'user',
    message: { role: 'user', content: 'HOST-LANE FRAME (between turns)' },
    isMeta: true,
    uuid: 'q7-host-frame',
  } as unknown as Msg
  shared.push(hostFrame)
  const second = await runAsk({
    turns: [{ kind: 'text', text: 'You said Ozymandias.' }],
    prompt: 'what did I say two turns ago?',
    mutableMessages: shared,
  })
  const secondWire = second.api.messageRequests().at(-1)
  const wireMessages = j((secondWire?.body as { messages?: unknown })?.messages ?? [])
  check(
    "THE PROBE (the request dump): turn 2's wire request carries turn 1's PROMPT — 'what did I say two turns ago' is answerable",
    wireMessages.includes('my name is Ozymandias'),
    wireMessages.slice(0, 220),
  )
  check("…and turn 1's assistant reply rides the same request (the whole prior turn, never the prompt alone)", wireMessages.includes('THE FIRST ANSWER.'))
  check('…and the between-turns host frame survived the write-back (append-only, never a clobber)', shared.includes(hostFrame))
  check('the shared array grew again behind turn 2 (the conversation accumulates)', j(shared).includes('what did I say two turns ago?') && j(shared).includes('You said Ozymandias.'))
  const firstWireCount = ((first.api.messageRequests().at(-1)?.body as { messages?: unknown[] })?.messages ?? []).length
  const secondWireCount = ((secondWire?.body as { messages?: unknown[] })?.messages ?? []).length
  check(
    'POISON (the amnesia shape): the second request is strictly LONGER than the first — a re-seeded turn sends the boot state plus the newest prompt alone',
    firstWireCount > 0 && secondWireCount > firstWireCount,
    `first=${firstWireCount} second=${secondWireCount}`,
  )
  const { readFileSync } = await import('node:fs')
  check(
    'the daemon-hosted seat IS a write-back caller (run.ts hands its one session array into ask as mutableMessages)',
    readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'run.ts'), 'utf8').includes('mutableMessages: messages,'),
  )
}

section('Q2 — a customSystemPrompt replaces the default but NEVER the identity floor')
{
  const { api, out } = await runAsk({
    turns: [{ kind: 'text', text: 'Q2 reply.' }],
    customSystemPrompt: 'You are a bare replacement bot for the floor test.',
  })
  const body = api.messageRequests()[0]?.body as { system?: Array<{ text?: string }> | string }
  const systemText = typeof body?.system === 'string' ? body.system : (body?.system ?? []).map(b => b.text ?? '').join('\n---\n')
  check('the wire system prompt is the CUSTOM one (default replaced)', systemText.includes('bare replacement bot for the floor test'))
  check('the Mercury identity floor is PREPENDED ahead of it', systemText.indexOf('Mercury') !== -1 && systemText.indexOf('Mercury') < systemText.indexOf('bare replacement bot'), systemText.slice(0, 120))
  check('the run still completes', (out.at(-1) as SdkMsg)?.type === 'outcome' && (out.at(-1) as SdkMsg)?.status === 'completed')
}

section('Q3 — a non-allow canUseTool lands in the outcome\'s denials')
{
  const tool = makeFakeTool()
  let canUseCalls = 0
  const { api, out } = await runAsk({
    turns: [
      { kind: 'tool_use', name: 'QeProbeTool', input: {}, id: 'toolu_qe_deny' },
      { kind: 'text', text: 'Q3 after denial.' },
    ],
    tools: [tool],
    canUseTool: async () => {
      canUseCalls++
      return { behavior: 'deny', message: 'denied by the harness', decisionReason: { type: 'other', reason: 'harness' } }
    },
  })
  check('the wrapped canUseTool was consulted exactly once', canUseCalls === 1, `${canUseCalls}`)
  check('two model calls (the tool turn + the follow-up)', api.messageRequests().length === 2, `${api.messageRequests().length}`)
  const result = out.at(-1) as SdkMsg & {
    denials?: Array<{ tool?: string; call_id?: string }>
  }
  check('the run completes despite the denial', result?.type === 'outcome' && result?.status === 'completed', j({ t: result?.type, s: result?.status }))
  const denials = result?.denials ?? []
  check('denials carries the denied call', denials.length === 1 && denials[0]?.tool === 'QeProbeTool' && denials[0]?.call_id === 'toolu_qe_deny', j(denials))
}

section('Q4 — the maxTurns attachment settles the turn as turn_limit')
{
  const tool = makeFakeTool()
  const { out } = await runAsk({
    turns: [
      { kind: 'tool_use', name: 'QeProbeTool', input: {}, id: 'toolu_qe_turns' },
      { kind: 'text', text: 'Q4 never reached?' },
    ],
    tools: [tool],
    maxTurns: 1,
  })
  const result = out.at(-1) as SdkMsg & { error?: { message?: string; class?: string } }
  check('the outcome is turn_limit', result?.type === 'outcome' && result?.status === 'turn_limit', j({ t: result?.type, s: result?.status }))
  check('the error names the limit in its own class', result?.error?.class === 'turn_limit' && String(result?.error?.message).includes('maximum number of turns'), j(result?.error))
}

section('Q5 — a met budget ceiling settles the turn as budget_limit')
{
  const { out } = await runAsk({
    turns: [{ kind: 'text', text: 'Q5 reply.' }],
    maxBudgetUsd: 0,
  })
  const result = out.at(-1) as SdkMsg & { error?: { message?: string; class?: string } }
  check('the outcome is budget_limit', result?.type === 'outcome' && result?.status === 'budget_limit', j({ t: result?.type, s: result?.status }))
  check('the error names the budget in its own class', result?.error?.class === 'budget_limit' && String(result?.error?.message).includes('maximum budget'), j(result?.error))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ TURN LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} TURN LAW FAILURE(S)`)
process.exit(1)
