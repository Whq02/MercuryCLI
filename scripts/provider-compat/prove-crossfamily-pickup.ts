#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-crossfamily-pickup.ts — the cross-family
//  pickup journey: an interview transcript born on one provider family,
//  STOPPED mid-turn by the operator, switched, and asked to pick up on the
//  other family — proven BOTH directions on validating loopback fixtures.
//
//  The incident: GPT-5.6 Sol ran an Apollo interview to plan
//  completion; the operator stopped the agent, switched to Opus 5, said
//  "pick up" — and the turn wedged. This prover pins the whole seam:
//
//    · the switched history carries everything real interviews carry —
//      an AskUserQuestion tool round with its structured answer, a Bash
//      round, foreign (unsigned) thinking, and the operator's stop: an
//      ORPHANED tool_use with no result, followed by the interruption line
//    · the fixtures VALIDATE like the real APIs: the anthropic endpoint
//      400s unpaired tool_use ids and unsigned thinking; the responses
//      endpoint 400s unanswered function_calls and foreign reasoning items
//    · the preflight (buildTransitionPlan) names its lossy items by message
//      uuid BEFORE the wire is touched — typed, never a wedge
//    · switch-to-first-event is MEASURED (fixture-scale: proves the
//      instrument and the conversion cost is client-side visible; live
//      numbers belong to the live drive)
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-crossfamily-pickup.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crossfamily-pickup-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
const text = (v: unknown): string => JSON.stringify(v) ?? ''
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'picking up the plan' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
const responsesSse = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: 'picking up the plan' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'picking up the plan' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
const OPENAI_MODELS_BODY = {
  models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text'], supported_in_api: true }],
}

// --- Wire validators (each 400 mirrors the real API's own refusal class) ----
function validateAnthropic(body: Body): string | null {
  const messages = (body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking' && !block.signature) {
        return 'Invalid `signature` in `thinking` block'
      }
      if (block.type !== 'tool_use') continue
      const next = messages[i + 1]
      const answered =
        next !== undefined &&
        next.role === 'user' &&
        Array.isArray(next.content) &&
        (next.content as Array<Record<string, unknown>>).some(
          c => c.type === 'tool_result' && c.tool_use_id === block.id,
        )
      if (!answered) return `tool_use ids were found without tool_result blocks immediately after: ${String(block.id)}`
    }
  }
  return null
}
function validateResponses(body: Body): string | null {
  const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
  const outputs = new Set(input.filter(i => i.type === 'function_call_output').map(i => String(i.call_id)))
  for (const item of input) {
    if (item.type === 'reasoning') return 'reasoning items cannot replay across models'
    if (item.type === 'function_call' && !outputs.has(String(item.call_id))) {
      return `No tool output found for function call ${String(item.call_id)}`
    }
  }
  return null
}

const captured: Array<{ path: string; body: Body; at: number }> = []
const rejected: Array<{ path: string; reason: string }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(path.startsWith('/openai/') ? OPENAI_MODELS_BODY : { object: 'list', data: [] }))
      return
    }
    if (req.method === 'POST' && (path.endsWith('/v1/messages') || path.endsWith('/responses'))) {
      captured.push({ path, body, at: performance.now() })
      const problem = path.endsWith('/v1/messages') ? validateAnthropic(body) : validateResponses(body)
      if (problem !== null) {
        rejected.push({ path, reason: problem })
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: problem } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(path.endsWith('/v1/messages') ? anthropicSse() : responsesSse())
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
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
})

console.log('============================================================')
console.log(' cross-family pickup — stopped mid-turn, switched, picked up')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage, createUserInterruptionMessage } = await import('../../src/utils/messages.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { ASK_USER_QUESTION_TOOL_NAME } = await import('../../src/tools/AskUserQuestionTool/prompt.ts')
const { buildTransitionPlan, transitionSourceRevision } = await import('../../src/services/providers/transitionPreview.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Message = import('../../src/types/message.ts').Message

const BASH = BashTool.name

function assistantTurn(model: string, content: unknown[], stopReason: string): AssistantMessage {
  const turn = createAssistantMessage({ content: content as never })
  turn.message.model = model
  turn.message.stop_reason = stopReason as never
  return turn
}

/** The interview transcript born on GPT-5.6 Sol, stopped mid-turn. */
function gptBornHistory(): Message[] {
  return [
    createUserMessage({ content: 'interview me about finishing the migration plan' }),
    assistantTurn('gpt-5.6-sol', [
      { type: 'thinking', thinking: 'sol reasoning summary: ask scope first', signature: '' },
      { type: 'text', text: 'Starting the interview.', citations: null },
      { type: 'tool_use', id: 'call_ask_1', name: ASK_USER_QUESTION_TOOL_NAME, input: { questions: [{ question: 'Which services migrate first?', header: 'Scope', options: [{ label: 'auth' }, { label: 'billing' }], multiSelect: false }] } },
    ], 'tool_use'),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_ask_1', content: JSON.stringify({ answers: { Scope: 'auth' } }) }] as never }),
    assistantTurn('gpt-5.6-sol', [
      { type: 'text', text: 'Checking the repo layout.', citations: null },
      { type: 'tool_use', id: 'call_bash_1', name: BASH, input: { command: 'ls services/' } },
    ], 'tool_use'),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_bash_1', content: 'auth\nbilling\nledger' }] as never }),
    assistantTurn('gpt-5.6-sol', [
      { type: 'text', text: 'Writing the plan now.', citations: null },
      { type: 'tool_use', id: 'call_bash_stopped', name: BASH, input: { command: 'cat services/auth/README.md' } },
    ], 'tool_use'),
    // The operator pressed stop DURING that call: no tool_result exists.
    createUserInterruptionMessage({ toolUse: true }),
    createUserMessage({ content: 'pick up where the interview left off and finish the plan' }),
  ]
}

/** The same journey born on Opus (signed thinking, toolu ids), stopped. */
function claudeBornHistory(): Message[] {
  return [
    createUserMessage({ content: 'interview me about finishing the migration plan' }),
    assistantTurn('claude-opus-5', [
      { type: 'thinking', thinking: 'plan the interview arc', signature: 'sig-native-1' },
      { type: 'text', text: 'Starting the interview.', citations: null },
      { type: 'tool_use', id: 'toolu_ask_1', name: ASK_USER_QUESTION_TOOL_NAME, input: { questions: [{ question: 'Which services migrate first?', header: 'Scope', options: [{ label: 'auth' }, { label: 'billing' }], multiSelect: false }] } },
    ], 'tool_use'),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_ask_1', content: JSON.stringify({ answers: { Scope: 'auth' } }) }] as never }),
    assistantTurn('claude-opus-5', [
      { type: 'text', text: 'Checking the repo layout.', citations: null },
      { type: 'tool_use', id: 'toolu_bash_stopped', name: BASH, input: { command: 'ls services/' } },
    ], 'tool_use'),
    createUserInterruptionMessage({ toolUse: true }),
    createUserMessage({ content: 'pick up where the interview left off and finish the plan' }),
  ]
}

async function drive(model: string, history: Message[]): Promise<{
  body: Body | undefined
  path: string | undefined
  last: AssistantMessage | undefined
  errors: AssistantMessage[]
  threw: unknown
  msToFirstAssistantEvent: number
}> {
  const before = captured.length
  const assistants: AssistantMessage[] = []
  let threw: unknown
  const t0 = performance.now()
  let firstEventAt: number | null = null
  try {
    for await (const item of routedCallModel({
      messages: history as never,
      systemPrompt: ['fixture system prompt: finish the interview'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [BashTool] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model,
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      if (firstEventAt === null) firstEventAt = performance.now()
      if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
    }
  } catch (error) {
    threw = error
  }
  const request = captured.slice(before).at(-1)
  return {
    body: request?.body,
    path: request?.path,
    last: assistants.filter(a => !a.isApiErrorMessage).at(-1),
    errors: assistants.filter(a => a.isApiErrorMessage),
    threw,
    msToFirstAssistantEvent: (firstEventAt ?? performance.now()) - t0,
  }
}

// ============================================================================
section('preflight · the plan names its losses by message BEFORE any wire')
// ============================================================================
const gptHistory = gptBornHistory()
const claudeHistory = claudeBornHistory()
{
  const plan = buildTransitionPlan({ messages: gptHistory, from: 'gpt-5.6-sol', to: 'claude-opus-5' })
  check('GPT→Claude: the plan is cross-provider and typed', plan.crossProvider && plan.targetRoute === 'anthropic')
  check('GPT→Claude: foreign thinking surfaces as thinking-continuity-reset', plan.counts['thinking-continuity-reset'] >= 1, text(plan.counts))
  const thinkingTurnUuid = (gptHistory[1] as { uuid: string }).uuid
  check('GPT→Claude: the lossy item names the exact message (the failing-index honesty)', plan.items.some(i => i.ref === thinkingTurnUuid), text(plan.items))
  check('GPT→Claude: meaningful loss gates needsChoice — never an auto-apply', plan.needsChoice === true)
  const appended = [...gptHistory, createUserMessage({ content: 'one more thing' })]
  check('an append makes the plan stale by revision (never silently reused)', transitionSourceRevision(appended as never) !== plan.sourceRevision)
}
{
  const plan = buildTransitionPlan({ messages: claudeHistory, from: 'claude-opus-5', to: 'gpt-5.6-sol' })
  check('Claude→GPT: the plan is cross-provider and typed', plan.crossProvider && plan.targetRoute === 'openai')
  check('Claude→GPT: native thinking cannot ride — counted as a reset class', plan.counts['thinking-continuity-reset'] + plan.counts['stateless-replay-reset'] >= 1, text(plan.counts))
}

// ============================================================================
section('GPT → Claude · the incident direction (validating anthropic wire)')
// ============================================================================
{
  const o = await drive('claude-opus-5', gptHistory)
  const body = o.body ?? {}
  check('the pickup turn settled end_turn on the anthropic lane', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn' && o.path === '/v1/messages', `threw=${String(o.threw)} errors=${o.errors.map(e => text(e.message.content)).join('|').slice(0, 200)} path=${o.path}`)
  check('the fixture validator accepted the wire (no pairing/signature refusal)', rejected.length === 0, text(rejected))
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  check('the ORPHANED stop-call was healed with a synthetic result before the wire', text(messages).includes('call_bash_stopped') && validateAnthropic(body) === null)
  check('the interview answer content survived the switch', text(messages).includes('answers'))
  check('foreign unsigned thinking never reached the anthropic wire', !text(body).includes('sol reasoning summary'))
  check('the interruption line rode as ordinary user text', text(messages).includes('[Request interrupted by user for tool use]'))
  console.log(`  · switch-to-first-assistant-event (fixture): ${o.msToFirstAssistantEvent.toFixed(0)}ms`)
}

// ============================================================================
section('Claude → GPT · the reverse direction (validating responses wire)')
// ============================================================================
{
  rejected.length = 0
  const o = await drive('gpt-5.6-sol', claudeHistory)
  const body = o.body ?? {}
  check('the pickup turn settled end_turn on the openai lane', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn' && o.path?.endsWith('/responses') === true, `threw=${String(o.threw)} errors=${o.errors.map(e => text(e.message.content)).join('|').slice(0, 200)} path=${o.path}`)
  check('the fixture validator accepted the wire (every function_call answered)', rejected.length === 0, text(rejected))
  const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
  check('the ORPHANED stop-call was healed before the responses wire', input.some(i => i.type === 'function_call' && i.call_id === 'toolu_bash_stopped') && validateResponses(body) === null, input.map(i => `${i.type}:${i.call_id ?? ''}`).join(','))
  check('native thinking never replayed to the responses wire', !input.some(i => i.type === 'reasoning') && !text(body).includes('plan the interview arc'))
  check('the interview answer content survived the switch', text(input).includes('answers'))
  console.log(`  · switch-to-first-assistant-event (fixture): ${o.msToFirstAssistantEvent.toFixed(0)}ms`)
}

server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
