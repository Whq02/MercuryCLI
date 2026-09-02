// ============================================================================
//  scripts/lib/crossfamilyConcourseFixture.ts — the ONE loopback fixture for
//  the concourse cross-family provers (kernel + arena): three provider
//  dialects on one server, content-routed and stateless.
//
//  Routing law: a /v1/messages POST whose body carries the <switchboard
//  block is a COORDINATOR turn (the Anthropic coordinator chair); any other
//  /v1/messages POST is a SEAT turn. /openai/v1/responses is the GPT
//  coordinator chair (Responses dialect); /zai/v4/chat/completions the GLM
//  chair (chat-completions dialect). Stateless by content: side calls can
//  never starve a scripted queue, and repeated turns re-derive their answer
//  from the conversation itself (a delivered tool result closes with the
//  dialect's ack).
//
//  Seat styles: 'instant' answers one final text per turn (kernel prover —
//  fast settles); 'paced' opens with the marker text then a Bash sleep
//  tool_use, so the seat stays UNMISTAKABLY mid-turn for ~sleepSeconds while
//  an operator enters it (arena prover), closing with its -done text when
//  the tool result returns.
// ============================================================================
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type FixtureLane = 'anthropic-coordinator' | 'anthropic-seat' | 'openai' | 'openai-seat' | 'zai' | 'zai-seat' | 'openrouter' | 'openrouter-seat' | 'other'
export interface FixtureHit {
  lane: FixtureLane
  path: string
  model: string
  body: Record<string, unknown>
}

export const CMA_STEER_TEXT = 'steer-note: adjust the alpha seat heading'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

type Emit =
  | { tool: { name: string; input: unknown } }
  | { tools: Array<{ name: string; input: unknown }> }
  | { final: string }
  | { pre: string; tool: { name: string; input: unknown } }

/** Anthropic /v1/messages SSE — text and/or tool_use blocks, one message. */
function anthropicSse(kind: Emit): string {
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  const parts: string[] = [open]
  let index = 0
  if ('pre' in kind) {
    parts.push(
      `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: kind.pre } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
    )
    index++
  }
  const toolList = 'tools' in kind ? kind.tools : 'tool' in kind ? [kind.tool] : []
  if (toolList.length > 0) {
    for (const tool of toolList) {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fx_${Date.now() % 100000}_${index}`, name: tool.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
      index++
    }
    parts.push(
      `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
      `event: message_stop\n${sse({ type: 'message_stop' })}`,
    )
    return parts.join('')
  }
  parts.push(
    `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: (kind as { final: string }).final } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

/** OpenAI Responses SSE — function_call turn or final text. */
function responsesSse(kind: Emit): string {
  const toolList = 'tools' in kind ? kind.tools : 'tool' in kind ? [kind.tool] : []
  if (toolList.length > 0) {
    return [
      sse({ type: 'response.created', response: { id: 'resp_fx' } }),
      ...toolList.map((tool, i) =>
        sse({ type: 'response.output_item.done', item: { type: 'function_call', name: tool.name, call_id: `call_fx_${Date.now() % 100000}_${i}`, arguments: JSON.stringify(tool.input) } }),
      ),
      sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
    ].join('')
  }
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: kind.final }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: kind.final }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

/** chat-completions SSE (zai) — tool_calls turn or final text. */
function chatSse(kind: Emit): string {
  const toolList = 'tools' in kind ? kind.tools : 'tool' in kind ? [kind.tool] : []
  if (toolList.length > 0) {
    return [
      sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolList.map((tool, i) => ({ index: i, id: `call_fx_${Date.now() % 100000}_${i}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } })) } }] }),
      sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ].join('')
  }
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: kind.final } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')
}

/** The board the coordinator reads travels as a `<switchboard>{JSON}` block
 *  inside ONE content string of the request (every dialect). Walk the
 *  parsed body for the newest such string, cut the JSON between the block
 *  tags, and parse it — the steer then targets the ROW, by exact title,
 *  never a text-proximity guess (the conversation tail also mentions
 *  titles, far from any id). */
function boardSessionsOf(body: unknown): Array<{ sessionId?: string; title?: string }> {
  const texts: string[] = []
  ;(function walk(v: unknown): void {
    if (typeof v === 'string') {
      if (v.includes('<switchboard')) texts.push(v)
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  })(body)
  // Newest parseable block wins: tool DESCRIPTIONS also say '<switchboard'
  // (list_sessions' own copy) but carry no JSON — skip anything that does
  // not parse to a board.
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!
    const tagAt = t.lastIndexOf('<switchboard')
    const open = t.indexOf('{', tagAt)
    const closeTag = t.indexOf('</switchboard>', tagAt)
    const close = t.lastIndexOf('}', closeTag >= 0 ? closeTag : t.length)
    if (open < 0 || close <= open) continue
    try {
      const parsed = JSON.parse(t.slice(open, close + 1)) as { board?: { sessions?: Array<{ sessionId?: string; title?: string }> } }
      if (parsed.board?.sessions !== undefined) return parsed.board.sessions
    } catch {
      /* not the block — keep looking */
    }
  }
  return []
}

function sessionIdByTitle(body: unknown, title: string): string | undefined {
  const sessions = boardSessionsOf(body)
  return sessions.find(s => s.title === title)?.sessionId ?? sessions[0]?.sessionId
}

type Op = 'launch' | 'launch-pair' | 'launch-gpt' | 'launch-plain' | 'launch-glm' | 'launch-haiku' | 'launch-nemotron' | 'steer' | 'ack' | 'final'
function routeOf(serialized: string): Op {
  if (/tool_result|function_call_output|"role":"tool"/.test(serialized)) return 'ack'
  const markers = ['cma-launch-pair', 'cma-launch-gpt', 'cma-launch-plain', 'cma-launch-glm', 'cma-launch-haiku', 'cma-launch-nemotron', 'cma-steer', 'cma-launch'] as const
  let best: { at: number; op: (typeof markers)[number] } | null = null
  for (const m of markers) {
    const at = serialized.lastIndexOf(m)
    if (at >= 0 && (best === null || at > best.at)) best = { at, op: m }
  }
  if (best === null) return 'final'
  if (best.op === 'cma-launch-pair') return 'launch-pair'
  if (best.op === 'cma-launch-gpt') return 'launch-gpt'
  if (best.op === 'cma-launch-plain') return 'launch-plain'
  if (best.op === 'cma-launch-glm') return 'launch-glm'
  if (best.op === 'cma-launch-haiku') return 'launch-haiku'
  if (best.op === 'cma-launch-nemotron') return 'launch-nemotron'
  if (best.op === 'cma-steer') return 'steer'
  return 'launch'
}

export interface CrossfamilyFixtureOpts {
  port: number
  /** Seat answering style — 'instant' (default) settles each turn in one
   *  final text; 'paced' opens marker text + a Bash sleep tool_use. */
  seatStyle?: 'instant' | 'paced'
  /** Seconds the paced seat's Bash sleep holds the turn live. */
  seatSleepSeconds?: number
  /** launch_session project fields per scripted launch (absent ⇒ the
   *  coordinator's own ground). */
  launchProjects?: { plain?: string; glm?: string; gpt?: string; haiku?: string; nemotron?: string; pairOne?: string; pairTwo?: string }
  /** The GPT id the models discovery serves (default gpt-5.5). */
  gptId?: string
  /** The reasoning levels the GPT models discovery offers (default ['high']
   *  — the historical shape; a prover pinning effort selection passes the
   *  fuller ladder so the pick is observable). */
  gptReasoningLevels?: readonly string[]
  /** The OpenRouter-carried id the catalogue serves (default the nemotron
   *  free row, in the product's own openrouter/ namespace spelling). */
  nemotronId?: string
  /** Append one JSON line per captured hit ({lane, path, model}) — a PTY
   *  battery in another process reads the wire truth from this file. */
  captureLog?: string
}

export interface CrossfamilyFixture {
  base: string
  captured: FixtureHit[]
  /** The env pins BOTH product processes need (daemon + UI + prover). */
  env: Record<string, string>
  close(): Promise<void>
}

export async function startCrossfamilyFixture(opts: CrossfamilyFixtureOpts): Promise<CrossfamilyFixture> {
  const captured: FixtureHit[] = []
  const gptId = opts.gptId ?? 'gpt-5.5'
  const nemotronId = opts.nemotronId ?? 'openrouter/nvidia/nemotron-nano-9b-v2:free'
  const record = (hit: FixtureHit): void => {
    captured.push(hit)
    if (opts.captureLog !== undefined) {
      try {
        appendFileSync(opts.captureLog, JSON.stringify({ lane: hit.lane, path: hit.path, model: hit.model }) + '\n')
      } catch {
        /* the in-process array still carries the truth */
      }
    }
  }
  const seatStyle = opts.seatStyle ?? 'instant'
  const sleepS = opts.seatSleepSeconds ?? 6

  function coordinatorScript(serialized: string, body: unknown, dialect: 'anthropic' | 'openai' | 'zai'): string {
    const emit = dialect === 'anthropic' ? anthropicSse : dialect === 'openai' ? responsesSse : chatSse
    const op = routeOf(serialized)
    if (op === 'ack') return emit({ final: `cma-${dialect}-ack: done.` })
    if (op === 'launch') return emit({ tool: { name: 'launch_session', input: { task: 'seat-task-alpha: work the alpha brief', title: 'CMA Alpha' } } })
    if (op === 'launch-pair') {
      // The PARALLEL round: two launch calls in ONE settlement — the live
      // two-session ask's shape (the round-loop must execute BOTH and
      // answer BOTH call ids on the next round).
      return emit({
        tools: [
          { name: 'launch_session', input: { task: 'seat-task-pair-one: work the first pair brief', title: 'CMA Pair One', ...(opts.launchProjects?.pairOne !== undefined ? { project: opts.launchProjects.pairOne } : {}) } },
          { name: 'launch_session', input: { task: 'seat-task-pair-two: work the second pair brief', title: 'CMA Pair Two', ...(opts.launchProjects?.pairTwo !== undefined ? { project: opts.launchProjects.pairTwo } : {}) } },
        ],
      })
    }
    if (op === 'launch-gpt') return emit({ tool: { name: 'launch_session', input: { task: 'seat-task-gpt: work on the gpt engine', title: 'CMA Gpt Seat', model: gptId, ...(opts.launchProjects?.gpt !== undefined ? { project: opts.launchProjects.gpt } : {}) } } })
    if (op === 'launch-plain') {
      return emit({ tool: { name: 'launch_session', input: { task: 'seat-task-plain: work the plain brief', title: 'CMA Plain', ...(opts.launchProjects?.plain !== undefined ? { project: opts.launchProjects.plain } : {}) } } })
    }
    if (op === 'launch-glm') {
      return emit({ tool: { name: 'launch_session', input: { task: 'seat-task-beta: work the beta brief', title: 'CMA Beta', ...(opts.launchProjects?.glm !== undefined ? { project: opts.launchProjects.glm } : {}) } } })
    }
    if (op === 'launch-haiku') {
      return emit({ tool: { name: 'launch_session', input: { task: 'seat-task-haiku: work the economy brief', title: 'CMA Haiku Seat', model: 'claude-haiku-4-5-20251001', ...(opts.launchProjects?.haiku !== undefined ? { project: opts.launchProjects.haiku } : {}) } } })
    }
    if (op === 'launch-nemotron') {
      return emit({ tool: { name: 'launch_session', input: { task: 'seat-task-nemotron: work the routed brief', title: 'CMA Nemotron Seat', model: nemotronId, ...(opts.launchProjects?.nemotron !== undefined ? { project: opts.launchProjects.nemotron } : {}) } } })
    }
    if (op === 'steer') {
      const sid = sessionIdByTitle(body, 'CMA Alpha')
      if (sid === undefined) return emit({ final: 'cma-steer-no-session: the board shows no session.' })
      return emit({ tool: { name: 'message_session', input: { sessionId: sid, text: CMA_STEER_TEXT } } })
    }
    return emit({ final: `cma-${dialect}-final.` })
  }

  function seatScript(serialized: string, dialect: 'anthropic' | 'openai' | 'zai' | 'openrouter' = 'anthropic'): string {
    const emit = dialect === 'anthropic' ? anthropicSse : dialect === 'openai' ? responsesSse : chatSse
    const closed = /tool_result|function_call_output|"role":"tool"/.test(serialized)
    const marker = serialized.includes(CMA_STEER_TEXT.slice(0, 20))
      ? 'steer'
      : serialized.includes('seat-task-alpha')
        ? 'alpha'
        : serialized.includes('seat-task-plain')
          ? 'plain'
          : serialized.includes('seat-task-beta')
            ? 'beta'
            : serialized.includes('seat-task-gpt')
              ? 'gpt'
            : serialized.includes('seat-task-haiku')
              ? 'haiku'
            : serialized.includes('seat-task-nemotron')
              ? 'nemotron'
              : serialized.includes('seat-task-pair-one')
                ? 'pair-one'
                : serialized.includes('seat-task-pair-two')
                  ? 'pair-two'
                  : 'spare'
    if (seatStyle === 'paced' && !closed && (marker === 'alpha' || marker === 'beta')) {
      return emit({
        pre: `${marker}-live body. `,
        tool: { name: 'Bash', input: { command: `sleep ${sleepS}; echo ${marker}`, description: `${marker} pause` } },
      })
    }
    if (closed) return emit({ final: `${marker === 'steer' ? 'steer' : marker}-done body.` })
    return emit({ final: `${marker}-landed body.` })
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
        if (path === '/openrouter/api/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              data: [
                {
                  id: nemotronId.replace(/^openrouter\//, ''),
                  name: 'NVIDIA Nemotron Nano 9B (free)',
                  context_length: 131072,
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
          )
          return
        }
        if (path === '/openrouter/api/v1/key') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: { label: 'fixture', usage: 0, limit: null, is_free_tier: true } }))
          return
        }
        if (path === '/openai/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              models: [
                {
                  slug: gptId,
                  display_name: gptId.toUpperCase(),
                  supported_reasoning_levels: (opts.gptReasoningLevels ?? ['high']).map(effort => ({ effort, description: effort })),
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
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        const isCoordinator = raw.includes('<switchboard')
        record({ lane: isCoordinator ? 'anthropic-coordinator' : 'anthropic-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(isCoordinator ? coordinatorScript(raw, body, 'anthropic') : seatScript(raw))
        return
      }
      if (req.method === 'POST' && path === '/openai/v1/responses') {
        // The same content-routing law as /v1/messages: the <switchboard
        // block marks a coordinator turn; without it this is a SEAT turn —
        // a sovereign session running whole on the Responses dialect.
        const isCoordinator = raw.includes('<switchboard')
        record({ lane: isCoordinator ? 'openai' : 'openai-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(isCoordinator ? coordinatorScript(raw, body, 'openai') : seatScript(raw, 'openai'))
        return
      }
      if (req.method === 'POST' && path === '/openrouter/api/v1/chat/completions') {
        const isCoordinator = raw.includes('<switchboard')
        record({ lane: isCoordinator ? 'openrouter' : 'openrouter-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(isCoordinator ? coordinatorScript(raw, body, 'zai') : seatScript(raw, 'openrouter'))
        return
      }
      if (req.method === 'POST' && path === '/zai/v4/chat/completions') {
        const isCoordinator = raw.includes('<switchboard')
        record({ lane: isCoordinator ? 'zai' : 'zai-seat', path, model: String(body.model ?? ''), body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(isCoordinator ? coordinatorScript(raw, body, 'zai') : seatScript(raw, 'zai'))
        return
      }
      record({ lane: 'other', path: `${req.method} ${path}`, model: '', body })
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
    MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
    OPENROUTER_API_KEY: 'fixture-or-key',
  }
  return {
    base,
    captured,
    env,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
