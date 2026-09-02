#!/usr/bin/env bun
// ============================================================================
//  scripts/turnEngine/prove-query-laws.ts — query()/queryLoop's TURN LAWS,
//  behaviorally.
//
//  Drives the REAL query() generator directly against the deterministic
//  fixture API (with fake tools where a tool round is needed) and freezes
//  the turn-band contract, including the coverage-map row the Phase 0
//  ledger explicitly deferred to Phase 8: CANCELLATION DURING A TOOL CALL
//  as a deterministic capture.
//
//    T1 the clean turn — one model call, the assistant text yields, the
//       generator returns Terminal {reason:'completed'}
//    T2 the tool round + follow-up loop — tool_use → the tool runs → the
//       tool_result user message → a SECOND model call → completed
//    T3 aborted_streaming — an abort mid-stream yields the user
//       interruption message and returns {reason:'aborted_streaming'}
//    T4 CANCELLATION DURING A TOOL CALL (the Phase-0 gap) — an abort while
//       a tool executes ends the turn as {reason:'aborted_tools'}: the
//       tool's interrupt/synthetic result is yielded so no tool_use is left
//       unanswered, the interruption message follows, and NO further model
//       call is made
//    T5 model_error — a non-retryable API refusal yields the API-error
//       assistant message and still terminalizes the generator normally
//
//  Run:  ~/.bun/bin/bun run scripts/turnEngine/prove-query-laws.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// NOT NODE_ENV=test — that arms the VCR record/replay layer (the 7.1 find).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'query-laws-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

import { z } from 'zod/v4'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'query-laws-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { query } = await import('../../src/query.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
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
  console.log('\n❌ TIMEOUT — query laws proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

// ── fixtures ────────────────────────────────────────────────────────────────

function makeGate(): { open: () => void; promise: Promise<void> } {
  let open!: () => void
  const promise = new Promise<void>(r => {
    open = r
  })
  return { open, promise }
}

function makeFakeTool(spec: {
  name?: string
  gate?: Promise<void>
  onStart?: () => void
} = {}): Record<string, unknown> {
  const name = spec.name ?? 'QueryProbeTool'
  return {
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    // 'cancel' so an abort-mid-call is the interruptible production shape.
    interruptBehavior: () => 'cancel' as const,
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: {} }),
    description: async () => 'query probe tool',
    prompt: async () => 'query probe tool prompt', // the wire serializer calls this (8B find)
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({
      type: 'tool_result',
      content: typeof data === 'string' ? data : j(data),
      tool_use_id: id,
    }),
    call: async (_input: unknown, ctx: { abortController: AbortController }) => {
      spec.onStart?.()
      if (spec.gate) {
        await Promise.race([
          spec.gate,
          new Promise<void>(resolve => {
            if (ctx.abortController.signal.aborted) return resolve()
            ctx.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
          }),
        ])
        if (ctx.abortController.signal.aborted) throw new Error('probe tool aborted')
      }
      return { data: 'probe tool ran' }
    },
  }
}

type Collected = {
  messages: Array<Record<string, unknown>>
  terminal: { reason: string } | undefined
  api: FixtureApi
  abort: AbortController
}

async function runQuery(opts: {
  turns: ScriptedTurn[]
  tools?: Array<Record<string, unknown>>
  abortWhen?: (api: FixtureApi, toolStarted: Promise<void>) => Promise<void>
  toolGate?: { open: () => void; promise: Promise<void> }
  onToolStart?: () => void
  toolStartedPromise?: Promise<void>
}): Promise<Collected> {
  const api = await startFixtureApi(opts.turns)
  process.env.ANTHROPIC_BASE_URL = api.url
  const abort = new AbortController()

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
  const tools = opts.tools ?? []
  const toolUseContext: Record<string, unknown> = {
    abortController: abort,
    getAppState: () => state,
    setAppState: (f: (p: Record<string, unknown>) => Record<string, unknown>) => {
      state = f(state)
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    toolDecisions: new Map(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    options: {
      commands: [],
      tools,
      mcpClients: [],
      mcpResources: {},
      mainLoopModel: 'claude-opus-4-8',
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      debug: false,
      verbose: false,
    },
  }

  if (opts.abortWhen) {
    void opts.abortWhen(api, opts.toolStartedPromise ?? Promise.resolve()).then(() => abort.abort())
  }

  const gen = query({
    messages: [createUserMessage({ content: 'Probe the turn.' })],
    systemPrompt: asSystemPrompt(['You are a turn probe. Reply tersely.']),
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    toolUseContext: toolUseContext as never,
    querySource: 'sdk',
  } as never)

  const messages: Array<Record<string, unknown>> = []
  let terminal: { reason: string } | undefined
  try {
    for (;;) {
      const r = await gen.next()
      if (r.done) {
        terminal = r.value as { reason: string }
        break
      }
      messages.push(r.value as Record<string, unknown>)
    }
  } finally {
    await api.close()
  }
  return { messages, terminal, api, abort }
}

const textOf = (m: Record<string, unknown>): string => j(m)
const realMessages = (ms: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  ms.filter(m => m.type === 'assistant' || m.type === 'user')

console.log('============================================================')
console.log(' query()/queryLoop — the turn laws')
console.log('============================================================')

// ── T1 the clean turn ───────────────────────────────────────────────────────
section("T1 — a clean text turn returns {reason:'completed'}")
{
  const r = await runQuery({ turns: [{ kind: 'text', text: 'T1 SCRIPTED.' }] })
  check('the assistant text yields', r.messages.some(m => m.type === 'assistant' && textOf(m).includes('T1 SCRIPTED.')))
  check("Terminal reason 'completed'", r.terminal?.reason === 'completed', r.terminal?.reason)
  check('exactly one model call', r.api.messageRequests().length === 1, `${r.api.messageRequests().length}`)
}

// ── T2 the tool round + follow-up loop ──────────────────────────────────────
section('T2 — tool_use → tool result → the follow-up model call → completed')
{
  const tool = makeFakeTool()
  const r = await runQuery({
    turns: [
      { kind: 'tool_use', name: 'QueryProbeTool', input: {}, id: 'toolu_t2' },
      { kind: 'text', text: 'T2 FOLLOW-UP.' },
    ],
    tools: [tool],
  })
  const toolResult = r.messages.find(m => m.type === 'user' && textOf(m).includes('toolu_t2'))
  check('the tool result user message yields', !!toolResult && textOf(toolResult).includes('probe tool ran'))
  check('the follow-up assistant text yields', r.messages.some(m => m.type === 'assistant' && textOf(m).includes('T2 FOLLOW-UP.')))
  check("Terminal reason 'completed'", r.terminal?.reason === 'completed', r.terminal?.reason)
  check('exactly two model calls (the round + the follow-up)', r.api.messageRequests().length === 2, `${r.api.messageRequests().length}`)
}

// ── T3 aborted_streaming ────────────────────────────────────────────────────
section("T3 — an abort mid-stream returns {reason:'aborted_streaming'} + the interruption message")
{
  const r = await runQuery({
    turns: [{ kind: 'hang', deltas: ['streaming…'] }],
    abortWhen: async api => {
      await api.messageRequestStarted(1)
      await new Promise(res => setTimeout(res, 150))
    },
  })
  check("Terminal reason 'aborted_streaming'", r.terminal?.reason === 'aborted_streaming', r.terminal?.reason)
  check('the user interruption message yields', r.messages.some(m => m.type === 'user' && textOf(m).includes(INTERRUPT_MESSAGE)), j(realMessages(r.messages)).slice(0, 300))
  check('exactly one model call (no post-abort continuation)', r.api.messageRequests().length === 1, `${r.api.messageRequests().length}`)
}

// ── T4 cancellation DURING a tool call (the Phase-0 coverage gap) ───────────
section("T4 — an abort while a tool executes returns {reason:'aborted_tools'}; nothing left unanswered")
{
  const gate = makeGate()
  let toolStartedResolve!: () => void
  const toolStarted = new Promise<void>(res => {
    toolStartedResolve = res
  })
  const tool = makeFakeTool({ gate: gate.promise, onStart: () => toolStartedResolve() })
  const r = await runQuery({
    turns: [
      { kind: 'tool_use', name: 'QueryProbeTool', input: {}, id: 'toolu_t4' },
      { kind: 'text', text: 'T4 NEVER REACHED.' },
    ],
    tools: [tool],
    toolStartedPromise: toolStarted,
    abortWhen: async (_api, started) => {
      await started
    },
  })
  check("Terminal reason 'aborted_tools'", r.terminal?.reason === 'aborted_tools', r.terminal?.reason)
  const answered = r.messages.find(m => m.type === 'user' && textOf(m).includes('toolu_t4'))
  check('the aborted tool_use is still ANSWERED (interrupt/synthetic tool_result)', !!answered, j(realMessages(r.messages)).slice(0, 400))
  // The tool-band variant: createUserInterruptionMessage({toolUse: true}).
  check('the TOOL-USE interruption message yields after the tool band', r.messages.some(m => m.type === 'user' && textOf(m).includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)))
  check('NO follow-up model call after the abort', r.api.messageRequests().length === 1, `${r.api.messageRequests().length}`)
}

// ── T5 model_error ──────────────────────────────────────────────────────────
section('T5 — a non-retryable API refusal yields the API-error assistant message')
{
  const r = await runQuery({
    turns: [{ kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'query fixture refusal' }],
  })
  check('an API-error assistant message yields', r.messages.some(m => m.type === 'assistant' && textOf(m).toLowerCase().includes('api error')), j(realMessages(r.messages)).slice(0, 300))
  check('the generator still terminalizes normally', r.terminal !== undefined && typeof r.terminal.reason === 'string', j(r.terminal))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ QUERY LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} QUERY LAW FAILURE(S)`)
process.exit(1)
