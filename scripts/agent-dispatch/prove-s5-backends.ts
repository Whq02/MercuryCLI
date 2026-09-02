#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-s5-backends.ts
//  PROOF (provider backends through AgentLaunchPlan + the
//  ONE role registry). Entirely fixture-driven — no network, no billables:
//
//    1. The callModel ROUTING LAW (services/providers/callModelRouter.ts):
//       glm ids → zai · gpt ids → the native openai runtime ·
//       everything else → anthropic; [1m]-rider stripping; the production
//       deps binding actually consumes the routed seam.
//    2. zaiCallModel yield contract against real wire bytes (global-fetch
//       fixture — the PRODUCTION call shape, no injected seam):
//       message_start first · live thinking/text deltas as Anthropic-shaped
//       stream events · ONE AssistantMessage per settled block · tool_use
//       settled EXACTLY ONCE at finish with parsed input · final usage +
//       stop_reason written back onto the LAST message by direct mutation ·
//       message_delta/message_stop close the stream.
//    3. Honest refusals: key-absent yields an API-error assistant message
//       (never a throw, never an Anthropic fallthrough); HTTP failure maps
//       the documented code table.
//    4. The launch-plan ENGINE LAW: BOTH engine backends ride
//       the in-process grammar — real definitions, the exact resolved id,
//       worktree/async laws intact, the never-Haiku floor never fires on
//       engine ids, and EVERY engine plan carries the
//       specialists-never-spawn-specialists tool denials.
//    5. The role registry access map is total over SPECIALIST_ROLES.
//
//  Run:  ~/.bun/bin/bun run scripts/agent-dispatch/prove-s5-backends.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { z } from 'zod'
import type { AssistantMessage, Message, StreamEvent } from '../../src/types/message.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' S5 — provider backends proof (fixture-driven)')
console.log('============================================================')

// Hermetic env bracket (config home pinned to scratch so a real stored
// provider secret can never flip the no-key assertions).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
const savedZaiKey = process.env.ZAI_API_KEY
const savedConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'prove-s5-home-'))

const { classifyModelRoute, declaredRouteOf } = await import('../../src/services/providers/callModelRouter.js')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.js')
const { buildAgentLaunchPlan } = await import(
  '../../src/utils/swarm/agentLaunchPlan.js'
)
const { SPECIALIST_ROLES, SPECIALIST_ROLE_ACCESS } = await import(
  '../../src/utils/router/providers/types.js'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')

//
section('1 · the callModel routing law')
//
{
  check("'glm-5.2' → zai", declaredRouteOf('glm-5.2') === 'zai')
  check("'glm' → zai", declaredRouteOf('glm') === 'zai')
  check("'GLM-5.2' case-folds → zai", declaredRouteOf('GLM-5.2') === 'zai')
  check("'glm-5.2[1m]' rider strips → zai", declaredRouteOf('glm-5.2[1m]') === 'zai')
  check("'gpt-5.6-sol' → openai", declaredRouteOf('gpt-5.6-sol') === 'openai')
  check("'gpt' → openai", declaredRouteOf('gpt') === 'openai')
  check("'GPT-5.6-SOL' case-folds → openai", declaredRouteOf('GPT-5.6-SOL') === 'openai')
  check(
    "'claude-opus-4-8[1m]' → anthropic (the declared first-party mark)",
    declaredRouteOf('claude-opus-4-8[1m]') === 'anthropic',
  )
  check("'claude-sonnet-5' → anthropic", declaredRouteOf('claude-sonnet-5') === 'anthropic')
  // RE-PINNED (the operator's phase-2 neutrality ruling): ''/undefined were
  // the remainder-era anthropic rows — absence is first-class now and never
  // classifies onto a lane.
  check("'' is ABSENCE — never a lane", classifyModelRoute('').kind === 'absence')
  check('undefined is ABSENCE — never a lane', classifyModelRoute(undefined).kind === 'absence')

  // The production deps binding consumes the routed seam (structural — the
  // deps factory wires callModel to routedCallModel, not the raw Anthropic
  // generator).
  const depsSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'query', 'deps.ts'), 'utf-8')
  // The scripted-stream seam sits AHEAD of the router: unset (the
  // production default) resolves to routedCallModel byte-identically; the
  // registered MERCURY_SCRIPTED_STREAM knob swaps a deterministic scripted
  // stream for rendered-capture choreography only.
  check('productionDeps binds callModel: scripted ?? routedCallModel', depsSrc.includes('callModel: scripted ?? routedCallModel'))
  check(
    'deps imports the router seam',
    depsSrc.includes("from '../services/providers/callModelRouter.js'"),
  )
}

//
section('1b · the home-lane admission at the dispatch seam (the neutrality ruling)')
//
// The Agent-tool road inherits the ONE admission owner: an id no family
// declares claims no engine grammar (resolveEngineDispatch's remainder is
// null — the in-process loop), and the loop's dispatch seam answers the
// typed refusal itself, before any HTTP — never a crash, never a silent
// swallow, never a wire probe (R3 of the neutrality ruling).
{
  const { routedCallModel } = await import('../../src/services/providers/callModelRouter.js')
  const { resolveEngineDispatch } = await import('../../src/utils/swarm/engineDispatch.js')
  const { FIRST_PARTY_MODEL_ENV_PINS } = await import('../../src/services/providers/idSpaces.js')
  const { createUserMessage } = await import('../../src/utils/messages.js')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
  // First-party-origin bracket: no gateway, no pin may earn the ride here.
  const savedFacts: Record<string, string | undefined> = {}
  for (const key of ['ANTHROPIC_BASE_URL', ...FIRST_PARTY_MODEL_ENV_PINS]) {
    savedFacts[key] = process.env[key]
    delete process.env[key]
  }
  try {
    check(
      'an unknown bare id claims no engine grammar (the remainder rides the in-process loop)',
      (await resolveEngineDispatch('banana-brew-9')) === null,
    )
    const seen: Array<{ err: boolean; text: string }> = []
    for await (const m of routedCallModel({
      messages: [createUserMessage({ content: 'hi' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'banana-brew-9',
        toolChoice: undefined,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'model_validation',
        mcpTools: [],
        maxOutputTokens: 1,
        maxRetries: 0,
        skipCacheWrite: true,
      },
    } as never)) {
      const am = m as {
        type?: string
        isApiErrorMessage?: boolean
        message?: { content?: Array<{ text?: string }> }
      }
      if (am.type === 'assistant') {
        seen.push({
          err: am.isApiErrorMessage === true,
          text: (am.message?.content ?? []).map(c => c.text ?? '').join(' '),
        })
      }
    }
    check(
      'the dispatch seam answers ONE typed assistant refusal — never a crash, never a silent swallow',
      seen.length === 1 && seen[0]!.err === true,
      JSON.stringify(seen),
    )
    const refusalText = seen[0]?.text ?? ''
    check(
      '…naming the id and the declared vocabulary on the sentence head',
      refusalText.includes("'banana-brew-9' is not a model id any provider family declares ("),
      refusalText,
    )
    check(
      '…and BOTH earned roads before any HTTP (the pin road and the gateway road)',
      /ANTHROPIC_\* model pin/.test(refusalText) && /ANTHROPIC_BASE_URL/.test(refusalText),
      refusalText,
    )
    // ABSENCE is its own honest refusal (the phase-2 ruling): a dispatch
    // handed no id never classifies onto a lane — it names the absence.
    const absenceSeen: Array<{ err: boolean; text: string }> = []
    for await (const m of routedCallModel({
      messages: [createUserMessage({ content: 'hi' })],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: '',
        toolChoice: undefined,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'model_validation',
        mcpTools: [],
        maxOutputTokens: 1,
        maxRetries: 0,
        skipCacheWrite: true,
      },
    } as never)) {
      const am = m as {
        type?: string
        isApiErrorMessage?: boolean
        message?: { content?: Array<{ text?: string }> }
      }
      if (am.type === 'assistant') {
        absenceSeen.push({
          err: am.isApiErrorMessage === true,
          text: (am.message?.content ?? []).map(c => c.text ?? '').join(' '),
        })
      }
    }
    check(
      "an EMPTY model refuses as ABSENCE — its own sentence, never the stranger's and never a lane",
      absenceSeen.length === 1 && absenceSeen[0]!.err === true && /no model id rides this call/.test(absenceSeen[0]!.text),
      JSON.stringify(absenceSeen),
    )
  } finally {
    for (const [key, value] of Object.entries(savedFacts)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── zaiCallModel fixture plumbing (global-fetch patch = the production call
//    shape; streamZaiChat spreads getProxyFetchOptions into real fetch) ─────
function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function responseFromChunks(chunks: string[], opts?: { status?: number; body?: unknown }): Response {
  if (opts?.status && opts.status !== 200) {
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch
let lastRequestBody: unknown
function patchFetch(makeResponse: () => Response): void {
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    lastRequestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return makeResponse()
  }) as unknown as typeof fetch
}
function restoreFetch(): void {
  globalThis.fetch = realFetch
}

const echoTool = {
  name: 'EchoTool',
  inputSchema: z.object({ text: z.string() }),
  prompt: async () => 'echoes text',
  isReadOnly: () => true,
} as never

const callParams = (model: string) => ({
  messages: [
    { type: 'user', message: { role: 'user', content: 'add 2+2' }, uuid: 'u1', timestamp: 't' },
  ] as unknown as Message[],
  systemPrompt: ['You are a specialist.'] as unknown as Parameters<typeof zaiCallModel>[0]['systemPrompt'],
  thinkingConfig: { type: 'enabled', budgetTokens: 4096 } as const,
  tools: [echoTool] as unknown as Parameters<typeof zaiCallModel>[0]['tools'],
  signal: new AbortController().signal,
  options: {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model,
    isNonInteractiveSession: true,
    querySource: 'agent:builtin:test' as never,
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    effortValue: 'high' as never,
  } as unknown as Parameters<typeof zaiCallModel>[0]['options'],
})

async function collectCall(model: string): Promise<Array<StreamEvent | AssistantMessage>> {
  const out: Array<StreamEvent | AssistantMessage> = []
  for await (const item of zaiCallModel(callParams(model))) {
    out.push(item as StreamEvent | AssistantMessage)
  }
  return out
}
const isApiErrorAssistant = (m: unknown): boolean => {
  const a = m as AssistantMessage
  return (
    a?.type === 'assistant' &&
    JSON.stringify(a.message?.content ?? '').includes('API Error')
  )
}

//
section('2 · zaiCallModel — the exact queryModelWithStreaming yield contract')
//
{
  process.env.ZAI_API_KEY = 'zai-proof-fake-key'
  patchFetch(() =>
    responseFromChunks([
      sseChunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking ' } }] }),
      sseChunk({ choices: [{ index: 0, delta: { reasoning_content: 'hard' } }] }),
      sseChunk({ choices: [{ index: 0, delta: { content: 'The answer' } }] }),
      sseChunk({ choices: [{ index: 0, delta: { content: ' is 4.' } }] }),
      sseChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'EchoTool', arguments: '{"te' } },
              ],
            },
          },
        ],
      }),
      sseChunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"four"}' } }] } },
        ],
      }),
      sseChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 } },
      }),
      'data: [DONE]\n\n',
    ]),
  )
  const yielded = await collectCall('glm-5.2')
  restoreFetch()

  const streamEvents = yielded.filter(y => y.type === 'stream_event') as StreamEvent[]
  const assistants = yielded.filter(y => y.type === 'assistant') as AssistantMessage[]
  const eventTypes = streamEvents.map(e => (e.event as { type: string }).type)

  check('first stream event is message_start', eventTypes[0] === 'message_start', eventTypes.join(','))
  check(
    'thinking + text deltas stream live (content_block_delta present before finish)',
    eventTypes.filter(t => t === 'content_block_delta').length >= 5,
    eventTypes.join(','),
  )
  check(
    'stream closes with message_delta then message_stop',
    eventTypes.at(-2) === 'message_delta' && eventTypes.at(-1) === 'message_stop',
    eventTypes.slice(-3).join(','),
  )
  check('THREE per-block AssistantMessages (thinking · text · tool_use)', assistants.length === 3, String(assistants.length))
  const blockTypes = assistants.map(a => (a.message.content[0] as { type: string })?.type)
  check(
    'block order thinking → text → tool_use',
    blockTypes.join(',') === 'thinking,text,tool_use',
    blockTypes.join(','),
  )
  const thinkingBlock = assistants[0]?.message.content[0] as { thinking?: string }
  check('thinking accumulated', thinkingBlock?.thinking === 'thinking hard', thinkingBlock?.thinking)
  const textBlock = assistants[1]?.message.content[0] as { text?: string }
  check('text accumulated', textBlock?.text === 'The answer is 4.', textBlock?.text)
  const toolBlock = assistants[2]?.message.content[0] as {
    id?: string
    name?: string
    input?: { text?: string }
  }
  check(
    'tool_use settled EXACTLY ONCE with parsed input',
    toolBlock?.id === 'call_1' && toolBlock?.name === 'EchoTool' && toolBlock?.input?.text === 'four',
    JSON.stringify(toolBlock),
  )
  const last = assistants.at(-1)!
  // The wire's prompt_tokens (120) INCLUDES its cached_tokens (50); the
  // canonical envelope is DISJOINT — uncached input beside cache_read — so
  // the cached prefix is never billed twice.
  check(
    'final usage written back onto the LAST message (direct mutation; inclusive wire → disjoint envelope)',
    last.message.usage?.input_tokens === 70 &&
      last.message.usage?.output_tokens === 30 &&
      last.message.usage?.cache_read_input_tokens === 50,
    JSON.stringify(last.message.usage),
  )
  check("final stop_reason 'tool_use'", last.message.stop_reason === 'tool_use', String(last.message.stop_reason))
  check(
    'earlier messages keep zero usage (only the last is settled)',
    assistants[0]!.message.usage?.input_tokens === 0,
  )

  // Request-side spot checks: the wire body carried the mapped request.
  const body = lastRequestBody as {
    model?: string
    tools?: Array<{ function?: { name?: string } }>
    reasoning_effort?: string
    thinking?: { type?: string }
    stream?: boolean
  }
  check('request model is the exact id', body?.model === 'glm-5.2')
  check('request streams', body?.stream === true)
  check('tools mapped through the one schema truth', body?.tools?.[0]?.function?.name === 'EchoTool')
  check("reasoning_effort passes through ('high')", body?.reasoning_effort === 'high')
  check('thinking enabled', body?.thinking?.type === 'enabled')
  check(
    'the key never rides the body',
    !JSON.stringify(body).includes('zai-proof-fake-key'),
  )
}

//
section('3 · honest refusals + fault mapping (never a throw, never a fallthrough)')
//
{
  // Key absent.
  delete process.env.ZAI_API_KEY
  const noKeyYield = await collectCall('glm-5.2')
  check(
    'no-key: ONE API-error assistant message naming ZAI_API_KEY',
    noKeyYield.length === 1 &&
      isApiErrorAssistant(noKeyYield[0]) &&
      JSON.stringify(noKeyYield[0]).includes('ZAI_API_KEY'),
  )

  // HTTP failure maps the documented table (401/1002-class) — non-retryable,
  // so exactly one attempt.
  process.env.ZAI_API_KEY = 'zai-proof-fake-key'
  let fetchCalls = 0
  patchFetch(() => {
    fetchCalls++
    return responseFromChunks([], { status: 401, body: { error: { code: 1002, message: 'auth failed' } } })
  })
  const httpFail = await collectCall('glm-5.2')
  restoreFetch()
  check(
    'HTTP 401 → ONE API-error assistant message with the zai code',
    httpFail.length === 1 &&
      isApiErrorAssistant(httpFail[0]) &&
      JSON.stringify(httpFail[0]).includes('zai-1002'),
    JSON.stringify(httpFail[0]).slice(0, 160),
  )
  check('non-retryable fault: exactly one attempt', fetchCalls === 1, String(fetchCalls))

  // Retryable pre-content fault (HTTP 500) retries ONCE then surfaces.
  fetchCalls = 0
  patchFetch(() => {
    fetchCalls++
    return responseFromChunks([], { status: 500, body: { error: { message: 'boom' } } })
  })
  const retried = await collectCall('glm-5.2')
  restoreFetch()
  check('retryable pre-content fault: exactly two attempts (bounded)', fetchCalls === 2, String(fetchCalls))
  check('…then ONE API-error assistant message', retried.length === 1 && isApiErrorAssistant(retried[0]))
}

//
section('4 · the launch-plan engine law (role→sandbox · denials · no floor)')
//
{
  const GENERAL = {
    agentType: 'general-purpose',
    whenToUse: 'default',
    source: 'built-in',
    getSystemPrompt: () => 'general',
  } as never
  const FORK_STUB = {
    agentType: 'fork-stub',
    whenToUse: 'fork stub',
    source: 'built-in',
    getSystemPrompt: () => 'fork',
  } as never
  const base = {
    activeAgents: [GENERAL] as never,
    toolPermissionContext: getEmptyToolPermissionContext(),
    forkGateOn: false,
    forkAgent: FORK_STUB,
    defaultAgentType: 'general-purpose',
    mainLoopModel: 'claude-opus-4-8',
    backgroundTasksDisabled: false,
    forceAsync: false,
  }

  // openai: the in-process shape — real definitions, exact id, the
  // worktree law honors the explicit param, async law intact.
  const gptPlan = buildAgentLaunchPlan({
    ...base,
    requestedType: 'general-purpose',
    engineDispatch: { backend: 'openai', model: 'gpt-5.6-sol' },
  })
  check("openai: model is the exact resolved id", gptPlan.model === 'gpt-5.6-sol')
  check("openai: real definition resolved", gptPlan.definition === (GENERAL as never))
  check("openai: engine backend recorded", gptPlan.engineBackend === 'openai')
  check('openai: no floor note fired', gptPlan.flooredFrom === undefined)
  // Provider-parity ruling: engine-backed plans carry NO tool
  // denials — the spawn surfaces stay (agent slots are model-agnostic; the
  // parent's provider never constrains the child's).
  check(
    'openai: no specialist tool denials on the plan (spawn surfaces kept)',
    !('engineToolDenials' in gptPlan),
  )
  check(
    'openai: model note surfaces the engine',
    (gptPlan.modelNote ?? '').includes('OpenAI') && (gptPlan.modelNote ?? '').includes('(gpt-5.6-sol)'),
    gptPlan.modelNote,
  )
  check('openai: no isolation unless asked', gptPlan.isolation === undefined)
  const gptWorktree = buildAgentLaunchPlan({
    ...base,
    requestedType: 'general-purpose',
    isolationParam: 'worktree',
    engineDispatch: { backend: 'openai', model: 'gpt-5.6-sol' },
  })
  check("openai: explicit worktree isolation honored", gptWorktree.isolation === 'worktree')
  const gptAsync = buildAgentLaunchPlan({
    ...base,
    requestedType: 'general-purpose',
    runInBackground: true,
    engineDispatch: { backend: 'openai', model: 'gpt-5.6-sol' },
  })
  check('openai: async law intact (runInBackground honored)', gptAsync.shouldRunAsync === true)

  // zai: real definitions + the exact resolved id; async law intact.
  const zaiPlan = buildAgentLaunchPlan({
    ...base,
    requestedType: 'general-purpose',
    runInBackground: true,
    engineDispatch: { backend: 'zai', model: 'glm-5.2' },
  })
  check("zai: model is the exact resolved id", zaiPlan.model === 'glm-5.2')
  check("zai: real definition resolved", zaiPlan.definition === (GENERAL as never))
  check('zai: async law intact (runInBackground honored)', zaiPlan.shouldRunAsync === true)
  check('zai: engine backend recorded', zaiPlan.engineBackend === 'zai')
  check('zai: no specialist tool denials on the plan (spawn surfaces kept)', !('engineToolDenials' in zaiPlan))
  check(
    'no sandbox concept survives on the plan (the codex role→sandbox law retired with the runtime)',
    !('engineSandbox' in zaiPlan) && !('engineRole' in zaiPlan),
  )
  check(
    'zai: model note surfaces the engine',
    (zaiPlan.modelNote ?? '').includes('Z.AI') && (zaiPlan.modelNote ?? '').includes('(glm-5.2)'),
    zaiPlan.modelNote,
  )

  // Anthropic grammar untouched when no dispatch rides.
  const plain = buildAgentLaunchPlan({ ...base, requestedType: 'general-purpose' })
  check('no dispatch: engine fields absent', plain.engineBackend === undefined && plain.engineToolDenials === undefined)

  // The denial list is retired at the owner — no export survives.
  {
    const launchPlanModule = await import('../../src/utils/swarm/agentLaunchPlan.js')
    check(
      'the specialist-denial export is retired (provider parity)',
      !('ENGINE_SPECIALIST_TOOL_DENIALS' in launchPlanModule),
    )
  }
}

//
section('5 · the role registry access map is total')
//
{
  check('six specialist roles', SPECIALIST_ROLES.length === 6)
  const total = SPECIALIST_ROLES.every(
    role => SPECIALIST_ROLE_ACCESS[role] === 'advisory' || SPECIALIST_ROLE_ACCESS[role] === 'authoring',
  )
  check('access map total over SPECIALIST_ROLES', total)
  check(
    'advisory = advisor/planner/reviewer',
    (['advisor', 'planner', 'reviewer'] as const).every(r => SPECIALIST_ROLE_ACCESS[r] === 'advisory'),
  )
  check(
    'authoring = debugger/implementer/test-author',
    (['debugger', 'implementer', 'test-author'] as const).every(r => SPECIALIST_ROLE_ACCESS[r] === 'authoring'),
  )
}

// Restore the ambient env exactly.
if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY
else process.env.ZAI_API_KEY = savedZaiKey
if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = savedConfigDir

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S5 BACKEND PROOFS PASS')
else console.log(`${failures} S5 BACKEND PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
