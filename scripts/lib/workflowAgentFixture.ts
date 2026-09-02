// ============================================================================
//  scripts/lib/workflowAgentFixture.ts — the ONE loopback fixture for the
//  workflow-hardening provers: three provider dialects on one server, each
//  playing a workflow SUBAGENT seat (not a coordinator).
//
//  Seat law, stateless and content-routed per request:
//    • a request whose serialized conversation carries a delivered tool ack
//      (anthropic tool_result · Responses function_call_output · chat
//      role:"tool") answers the dialect's FINAL text (`wf-<dialect>-done`);
//    • any other request answers ONE tool call — Bash `echo wf-<dialect>-mark`
//      — preceded by the dialect's reasoning shape when the knob asks for it
//      (chat: delta.reasoning_content · responses: a settled reasoning item
//      with a summary_text; the anthropic seat stays reasoning-silent, which
//      is the workflow default of thinking-disabled subagents).
//  A `throttle` knob makes the FIRST N requests of one dialect answer HTTP
//  429 (retry-after set) before the normal script resumes — the rate-limit
//  honesty leg. Every request is captured (lane, path, model, body).
//
//  Env pins returned in `env` route every family here: ANTHROPIC_BASE_URL,
//  MERCURY_OPENAI_API_BASE (+key), MERCURY_ZAI_API_BASE (+key). GET
//  /openai/v1/models serves the gpt id so cold registries accept it typed.
//  Ports: the workflow lane owns 34900–34999; callers pass an explicit port.
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type WorkflowFixtureLane = 'anthropic' | 'chat' | 'responses' | 'other'

export interface WorkflowFixtureHit {
  lane: WorkflowFixtureLane
  path: string
  model: string
  body: Record<string, unknown>
}

export interface WorkflowAgentFixtureOpts {
  port: number
  /** Emit the dialect's reasoning shape ahead of the tool call. */
  reasoning?: { chat?: boolean; responses?: boolean }
  /** First `times` requests on `lane` answer HTTP 429 (retry-after riding
   *  both the header and the body) before the normal seat script resumes. */
  throttle?: { lane: WorkflowFixtureLane; times: number; retryAfterSec?: number }
  /** Hold each lane's response for this long before answering — keeps an
   *  agent honestly IN FLIGHT while a prover switches models/renames. */
  latencyMs?: Partial<Record<WorkflowFixtureLane, number>>
  /** The gpt id the /openai/v1/models discovery serves (default gpt-5.5). */
  gptId?: string
}

export interface WorkflowAgentFixture {
  base: string
  captured: WorkflowFixtureHit[]
  /** Requests each lane answered 429 so far (throttle accounting). */
  throttled: Record<string, number>
  /** The env pins the product process needs to route every family here. */
  env: Record<string, string>
  close(): Promise<void>
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** Marker texts, exported so provers assert against one spelling. */
export const WF_FIXTURE_MARK = (lane: WorkflowFixtureLane): string => `wf-${lane}-mark`
export const WF_FIXTURE_DONE = (lane: WorkflowFixtureLane): string => `wf-${lane}-done.`
export const WF_FIXTURE_REASONING = (lane: WorkflowFixtureLane): string =>
  `wf-${lane}-reasoning: check the echo before answering.`

// ── anthropic /v1/messages SSE ───────────────────────────────────────────────
function anthropicToolTurn(command: string): string {
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_wf_${Date.now() % 1e6}`, type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  return [
    open,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_wf_${Date.now() % 1e6}`, name: 'Bash', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'fixture activity' }) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function anthropicFinalTurn(text: string): string {
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_wf_${Date.now() % 1e6}`, type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  return [
    open,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}

// Monotonic response sequence — every response carries a UNIQUE provider id
// (the real-wire shape; a reused id would collide any uuid derivation keyed
// on it and mask dedup truths).
let responseSeq = 0
const nextRespSeq = (): number => ++responseSeq

// ── chat-completions SSE (the zai lane) ──────────────────────────────────────
function chatToolTurn(command: string, reasoning: boolean): string {
  const id = `chat_wf_${nextRespSeq()}`
  const parts: string[] = []
  if (reasoning) {
    parts.push(
      sse({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: WF_FIXTURE_REASONING('chat') } }] }),
    )
  }
  parts.push(
    sse({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_wf_${nextRespSeq()}`, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command, description: 'fixture activity' }) } }] } }] }),
    sse({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 7 } }),
    'data: [DONE]\n\n',
  )
  return parts.join('')
}
function chatFinalTurn(text: string): string {
  const id = `chat_wf_${nextRespSeq()}`
  return [
    sse({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
    sse({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    'data: [DONE]\n\n',
  ].join('')
}

// ── OpenAI Responses SSE ─────────────────────────────────────────────────────
function responsesToolTurn(command: string, reasoning: boolean): string {
  const id = `resp_wf_${nextRespSeq()}`
  const parts: string[] = [sse({ type: 'response.created', response: { id } })]
  if (reasoning) {
    // Summaries stream as deltas on the live wire; the settled reasoning
    // item follows for the replay store.
    parts.push(
      sse({ type: 'response.reasoning_summary_text.delta', delta: WF_FIXTURE_REASONING('responses') }),
      sse({ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_wf_${nextRespSeq()}`, summary: [{ type: 'summary_text', text: WF_FIXTURE_REASONING('responses') }], encrypted_content: 'wf-fixture-opaque' } }),
    )
  }
  parts.push(
    sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'Bash', call_id: `call_wf_${nextRespSeq()}`, arguments: JSON.stringify({ command, description: 'fixture activity' }) } }),
    sse({ type: 'response.completed', response: { id, usage: { input_tokens: 9, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } } } }),
  )
  return parts.join('')
}
function responsesFinalTurn(text: string): string {
  const id = `resp_wf_${nextRespSeq()}`
  return [
    sse({ type: 'response.created', response: { id } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id, usage: { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

/** A delivered tool ack in ANY dialect's serialized conversation. */
export function conversationCarriesToolAck(serialized: string): boolean {
  return /tool_result|function_call_output|"role":"tool"/.test(serialized)
}

export async function startWorkflowAgentFixture(
  opts: WorkflowAgentFixtureOpts,
): Promise<WorkflowAgentFixture> {
  const captured: WorkflowFixtureHit[] = []
  const throttled: Record<string, number> = {}
  const gptId = opts.gptId ?? 'gpt-5.5'

  const maybeThrottle = (
    lane: WorkflowFixtureLane,
    res: ServerResponse,
  ): boolean => {
    const t = opts.throttle
    if (!t || t.lane !== lane) return false
    const used = throttled[lane] ?? 0
    if (used >= t.times) return false
    throttled[lane] = used + 1
    const retryAfter = t.retryAfterSec ?? 2
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(retryAfter),
    })
    res.end(
      lane === 'anthropic'
        ? JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `rate limited — retry after ${retryAfter}s` } })
        : JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: `rate limited — retry after ${retryAfter}s` } }),
    )
    return true
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }
      if (req.method === 'GET') {
        if (path === '/openai/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              models: [
                {
                  slug: gptId,
                  display_name: gptId.toUpperCase(),
                  supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
                  default_reasoning_level: 'high',
                  visibility: 'list',
                  priority: 1,
                  context_window: 272_000,
                  input_modalities: ['text'],
                  supported_in_api: true,
                },
              ],
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
        return
      }
      const closed = conversationCarriesToolAck(raw)
      const answer = (lane: WorkflowFixtureLane, sseBody: () => string): void => {
        if (maybeThrottle(lane, res)) return
        const hold = opts.latencyMs?.[lane] ?? 0
        const send = (): void => {
          if (res.destroyed || res.socket?.destroyed) return
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sseBody())
        }
        if (hold > 0) {
          const t = setTimeout(send, hold)
          t.unref?.()
        } else {
          send()
        }
      }
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        captured.push({ lane: 'anthropic', path, model: String(body.model ?? ''), body })
        answer('anthropic', () =>
          closed
            ? anthropicFinalTurn(WF_FIXTURE_DONE('anthropic'))
            : anthropicToolTurn(`echo ${WF_FIXTURE_MARK('anthropic')}`),
        )
        return
      }
      if (req.method === 'POST' && path === '/zai/v4/chat/completions') {
        captured.push({ lane: 'chat', path, model: String(body.model ?? ''), body })
        answer('chat', () =>
          closed
            ? chatFinalTurn(WF_FIXTURE_DONE('chat'))
            : chatToolTurn(`echo ${WF_FIXTURE_MARK('chat')}`, opts.reasoning?.chat === true),
        )
        return
      }
      if (req.method === 'POST' && path === '/openai/v1/responses') {
        captured.push({ lane: 'responses', path, model: String(body.model ?? ''), body })
        answer('responses', () =>
          closed
            ? responsesFinalTurn(WF_FIXTURE_DONE('responses'))
            : responsesToolTurn(`echo ${WF_FIXTURE_MARK('responses')}`, opts.reasoning?.responses === true),
        )
        return
      }
      captured.push({ lane: 'other', path: `${req.method} ${path}`, model: '', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(opts.port, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${opts.port}`
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
    MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
    MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
    OPENAI_API_KEY: 'fixture-openai-key',
    MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
    ZAI_API_KEY: 'fixture-zai-key',
  }
  return {
    base,
    captured,
    throttled,
    env,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
