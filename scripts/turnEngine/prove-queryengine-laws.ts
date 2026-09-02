#!/usr/bin/env bun
// ============================================================================
//  scripts/turnEngine/prove-queryengine-laws.ts — QueryEngine/ask() session
//  laws, behaviorally.
//
//  Drives the REAL ask() (QueryEngine.submitMessage) in-process against the
//  deterministic fixture API and freezes the SDK-envelope session laws that
//  the dist-level golden journeys (J1/J2) cannot see from outside:
//
//    Q1 envelope order + success result — system:init FIRST, assistant next,
//       result:success last; result carries the LAST TEXT block, the
//       message_delta-captured stop_reason, and the accumulated usage
//    Q2 the Mercury identity floor — a customSystemPrompt REPLACES the
//       default prompt but the identity/honesty floor is PREPENDED on the
//       wire; the custom prompt still rides second
//    Q3 denial capture — a non-allow canUseTool lands in the result's
//       permission_denials (tool name + tool_use_id)
//    Q4 error_max_turns — the maxTurns attachment terminalizes the turn as
//       an is_error result with the named errors[] row
//    Q5 error_max_budget_usd — the budget check fires on the first yielded
//       message when the ceiling is already met
//    Q6 ask() write-back — setReadFileCache receives the engine's cache in
//       the finally band (even though the caller's cache was cloned in)
//
//  Run:  ~/.bun/bin/bun run scripts/turnEngine/prove-queryengine-laws.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// NOT NODE_ENV=test — that arms the VCR record/replay layer (services/vcr.ts)
// which bypasses the fixture server (the Phase 7.1 find).

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

const { ask } = await import('../../src/QueryEngine.ts')
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
  console.log('\n❌ TIMEOUT — QueryEngine laws proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

// ── harness ─────────────────────────────────────────────────────────────────

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
    // The QUERY path serializes tool definitions for the wire via
    // tool.prompt() — runToolUse-level fakes (Phase 5) never needed it.
    prompt: async () => 'probe tool prompt',
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: async () => ({ data: 'probe tool ran' }),
  }
}

type SdkMsg = Record<string, unknown> & { type: string; subtype?: string }

async function runAsk(opts: {
  turns: ScriptedTurn[]
  prompt?: string
  tools?: Array<Record<string, unknown>>
  canUseTool?: (...a: unknown[]) => Promise<unknown>
  customSystemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  abortAfterFirstRequest?: boolean
  /** The session's own array (the write-back contract) — shared across calls. */
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
console.log(' QueryEngine / ask() — the SDK session laws')
console.log('============================================================')

// ── Q1 + Q6 ─────────────────────────────────────────────────────────────────
section('Q1 — envelope order · stop_reason capture · usage accumulation · last-TEXT result')
{
  const { api, out, cacheWrittenBack } = await runAsk({
    turns: [{ kind: 'text', text: 'Q1 SCRIPTED ANSWER.' }],
  })
  check('the FIRST envelope is system:init', out[0]?.type === 'system' && out[0]?.subtype === 'init', j(out[0]?.type))
  const assistant = out.find(m => m.type === 'assistant')
  check('an assistant envelope carries the scripted text', !!assistant && j(assistant).includes('Q1 SCRIPTED ANSWER.'))
  const result = out.at(-1) as SdkMsg & {
    result?: string
    stop_reason?: string
    usage?: { output_tokens?: number }
    num_turns?: number
    is_error?: boolean
  }
  check('the LAST envelope is result:success', result?.type === 'result' && result?.subtype === 'success', j({ t: result?.type, s: result?.subtype }))
  check('result.result is the scripted text (last TEXT block)', result?.result === 'Q1 SCRIPTED ANSWER.', result?.result)
  check("stop_reason is the message_delta-captured 'end_turn'", result?.stop_reason === 'end_turn', String(result?.stop_reason))
  check('usage accumulated from the stream (fixture output_tokens=12)', result?.usage?.output_tokens === 12, j(result?.usage))
  check('is_error false on the clean path', result?.is_error === false)
  check('exactly one model call', api.messageRequests().length === 1, `${api.messageRequests().length}`)
  check('Q6: ask() writes the read cache back in finally', cacheWrittenBack !== undefined && typeof (cacheWrittenBack as { dump?: unknown }).dump === 'function')
}

// ── Q7 the seat's memory — the ask() write-back contract (w5-f08-01) ────────
section('Q7 — the seat’s memory: ONE shared array across ask() calls carries the conversation (the amnesia concession)')
{
  // The daemon-hosted seat builds one ask() per delivered prompt over one
  // long-lived `messages` array. The engine copies its seed, so before the
  // write-back contract the array never learned a turn: every engine
  // re-seeded from the boot state and the model answered with amnesia —
  // Casual drives missed it because they never probe memory.
  type Msg = import('../../src/types/message.ts').Message
  const shared: Msg[] = []
  const first = await runAsk({
    turns: [{ kind: 'text', text: 'THE FIRST ANSWER.' }],
    prompt: 'my name is Ozymandias',
    mutableMessages: shared,
  })
  const firstResult = first.out.at(-1) as SdkMsg & { is_error?: boolean }
  check('turn 1 settles clean', firstResult?.type === 'result' && firstResult?.is_error === false, j({ t: firstResult?.type, e: firstResult?.is_error }))
  check(
    'the write-back landed: after turn 1 the shared array holds the prompt AND the reply',
    shared.length >= 2 && j(shared).includes('my name is Ozymandias') && j(shared).includes('THE FIRST ANSWER.'),
    `${shared.length} frames`,
  )
  // The host-lane law: a frame the host appends BETWEEN turns must survive
  // the next turn's write-back (append-only while the seed stays intact).
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
    'POISON (the amnesia shape): the second request is strictly LONGER than the first — a re-seeded engine sends the boot state plus the newest prompt alone',
    firstWireCount > 0 && secondWireCount > firstWireCount,
    `first=${firstWireCount} second=${secondWireCount}`,
  )
  const { readFileSync } = await import('node:fs')
  check(
    'the daemon-hosted seat IS a write-back caller (print.ts hands its one session array into ask as mutableMessages)',
    readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'print.ts'), 'utf8').includes('mutableMessages: messages,'),
  )
}

// ── Q2 the Mercury identity floor ───────────────────────────────────────────
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
  check('the run still completes', (out.at(-1) as SdkMsg)?.type === 'result')
}

// ── Q3 denial capture ───────────────────────────────────────────────────────
section('Q3 — a non-allow canUseTool lands in permission_denials')
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
    permission_denials?: Array<{ tool_name?: string; tool_use_id?: string }>
  }
  check('the run completes despite the denial', result?.type === 'result', j({ t: result?.type, s: result?.subtype }))
  const denials = result?.permission_denials ?? []
  check('permission_denials carries the denied call', denials.length === 1 && denials[0]?.tool_name === 'QeProbeTool' && denials[0]?.tool_use_id === 'toolu_qe_deny', j(denials))
}

// ── Q4 error_max_turns ──────────────────────────────────────────────────────
section('Q4 — the maxTurns attachment terminalizes as error_max_turns')
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
  const result = out.at(-1) as SdkMsg & { is_error?: boolean; errors?: string[] }
  check('the terminal result is error_max_turns', result?.type === 'result' && result?.subtype === 'error_max_turns', j({ t: result?.type, s: result?.subtype }))
  check('is_error with the named errors[] row', result?.is_error === true && (result?.errors ?? []).some(e => e.includes('maximum number of turns')), j(result?.errors))
}

// ── Q5 error_max_budget_usd ─────────────────────────────────────────────────
section('Q5 — a met budget ceiling terminalizes as error_max_budget_usd')
{
  const { out } = await runAsk({
    turns: [{ kind: 'text', text: 'Q5 reply.' }],
    maxBudgetUsd: 0,
  })
  const result = out.at(-1) as SdkMsg & { is_error?: boolean; errors?: string[] }
  check('the terminal result is error_max_budget_usd', result?.type === 'result' && result?.subtype === 'error_max_budget_usd', j({ t: result?.type, s: result?.subtype }))
  check('is_error with the named errors[] row', result?.is_error === true && (result?.errors ?? []).some(e => e.includes('maximum budget')), j(result?.errors))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ QUERYENGINE LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} QUERYENGINE LAW FAILURE(S)`)
process.exit(1)
