
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export type FixtureUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type ScriptedTurn = ScriptedTurnBody & { whenModel?: string }

type ScriptedTurnBody =
  | {
      kind: 'text'
      text: string
      stopReason?: string
      usage?: FixtureUsage
      thinking?: string
      inputTransformations?: unknown[]
      model?: string
      signature?: string
    }
  | {
      kind: 'tool_use'
      name: string
      input: Record<string, unknown>
      id?: string
      preText?: string
      thinking?: string
      inputTransformations?: unknown[]
      model?: string
      signature?: string
      usage?: FixtureUsage
    }
  | { kind: 'error'; status: number; errorType: string; message: string }
  | { kind: 'hang'; deltas: string[] }
  | { kind: 'paced'; deltas: string[]; gapMs: number; stopReason?: string; startDelayMs?: number; settleDelayMs?: number }
  | { kind: 'die'; deltas: string[] }
  | {
      kind: 'paced_tool_use'
      preDeltas: string[]
      gapMs: number
      tools: { name: string; input: Record<string, unknown>; id?: string }[]
    }
  | {
      kind: 'stream'
      blocks: { type: 'thinking' | 'text'; deltas: string[] }[]
      gapMs: number
      stopReason?: string
      headerDelayMs?: number
      firstChunkDelayMs?: number
      usage?: FixtureUsage
    }

export interface CapturedRequest {
  path: string
  method: string
  headers: Record<string, string>
  body: unknown
  raw: string
}

export interface UsageEndpointControl {
  mode: 'ok' | 'error' | 'hang'
  status: number
  payload: (n: number, bearer?: string) => unknown
  next?: (n: number) => void
}

export interface FixtureApi {
  port: number
  url: string
  requests: CapturedRequest[]
  usage: UsageEndpointControl
  usageRequests: { at: number; mode: UsageEndpointControl['mode']; n: number }[]
  pacedEmits: { turn: number; index: number; text: string; at: number }[]
  toolEmits: { turn: number; name: string; id: string; at: number }[]
  streamEmits: {
    turn: number
    blockIndex: number
    blockType: 'thinking' | 'text'
    index: number
    text: string
    at: number
  }[]
  messageRequests(): CapturedRequest[]
  refusals: { request: number; message: string }[]
  destroyedReplays(): number
  messageRequestStarted(n: number): Promise<void>
  sawClientAbort(): boolean
  close(): Promise<void>
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(id: string, usage?: FixtureUsage, inputTransformations?: unknown[], model?: string): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: model ?? 'claude-opus-4-8',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      ...(inputTransformations !== undefined ? { input_transformations: inputTransformations } : {}),
      usage: {
        input_tokens: usage?.input_tokens ?? 25,
        output_tokens: 1,
        ...(usage?.cache_read_input_tokens !== undefined
          ? { cache_read_input_tokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage?.cache_creation_input_tokens !== undefined
          ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
          : {}),
      },
    },
  })
}

function textBlocks(text: string, index = 0): string {
  return (
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    }) +
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    }) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index })
  )
}

function toolUseBlocks(
  id: string,
  name: string,
  input: Record<string, unknown>,
  index: number,
): string {
  return (
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    }) +
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index })
  )
}

function messageEnd(stopReason: string, usage?: FixtureUsage): string {
  return (
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage?.output_tokens ?? 12 },
    }) + sseEvent('message_stop', { type: 'message_stop' })
  )
}

function thinkingBlockStart(index: number): string {
  return sseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '' },
  })
}

function thinkingDelta(index: number, text: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking: text },
  })
}

function signatureDelta(index: number, signature = 'fixture-signature'): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature },
  })
}

function signedThinkingBlock(index: number, text: string, signature?: string): string {
  return (
    thinkingBlockStart(index) +
    thinkingDelta(index, text) +
    signatureDelta(index, signature) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index })
  )
}

export function renderTurn(turn: ScriptedTurn, msgSeq: number): string {
  const id = `msg_fixture_${msgSeq}`
  switch (turn.kind) {
    case 'text': {
      let body = messageStart(id, turn.usage, turn.inputTransformations, turn.model)
      let index = 0
      if (turn.thinking !== undefined) {
        body += signedThinkingBlock(index, turn.thinking, turn.signature)
        index++
      }
      body += textBlocks(turn.text, index)
      body += messageEnd(turn.stopReason ?? 'end_turn', turn.usage)
      return body
    }
    case 'tool_use': {
      let body = messageStart(id, turn.usage, turn.inputTransformations, turn.model)
      let index = 0
      if (turn.thinking !== undefined) {
        body += signedThinkingBlock(index, turn.thinking, turn.signature)
        index++
      }
      if (turn.preText) {
        body += textBlocks(turn.preText, index)
        index++
      }
      body += toolUseBlocks(
        turn.id ?? `toolu_fixture_${msgSeq}`,
        turn.name,
        turn.input,
        index,
      )
      body += messageEnd('tool_use', turn.usage)
      return body
    }
    case 'error':
    case 'hang':
    case 'die':
    case 'paced_tool_use':
    case 'stream':
      throw new Error(`renderTurn: ${turn.kind} is handled by the server, not rendered`)
  }
}

function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = stripCacheControl(v)
    }
    return out
  }
  return value
}

const BOUND_SIGNATURE_PREFIX = 'fixture-signature:'

function withoutThinking(message: unknown): unknown {
  const row = message as { content?: unknown }
  if (!row || !Array.isArray(row.content)) return message
  return { ...row, content: row.content.filter(b => { const t = (b as { type?: string }).type; return t !== 'thinking' && t !== 'redacted_thinking' }) }
}

function referencedToolNames(messages: unknown[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; name?: unknown; tool_name?: unknown; content?: unknown }
      if (b.type === 'tool_use' && typeof b.name === 'string') names.add(b.name)
      if (b.type === 'tool_reference' && typeof b.tool_name === 'string') names.add(b.tool_name)
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const inner of b.content) {
          const r = inner as { type?: string; tool_name?: unknown }
          if (r.type === 'tool_reference' && typeof r.tool_name === 'string') names.add(r.tool_name)
        }
      }
    }
  }
  return names
}

function boundTools(tools: unknown, messages: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return []
  const referenced = referencedToolNames(messages)
  return tools.filter(tool => {
    const t = tool as { name?: unknown; defer_loading?: unknown }
    return t.defer_loading !== true || (typeof t.name === 'string' && referenced.has(t.name))
  })
}

export function prefixHashOf(body: { system?: unknown; tools?: unknown }, messages: unknown[]): string {
  const material = JSON.stringify(stripCacheControl({ system: body.system, tools: boundTools(body.tools, messages), messages: messages.map(withoutThinking) }))
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

export function bindingRefusalOf(body: unknown, drops: unknown[]): string | null {
  const behavior = (body as { thinking?: { block_binding?: { prefix_mismatch_behavior?: unknown } } } | null)?.thinking?.block_binding?.prefix_mismatch_behavior
  if (behavior !== 'error' || drops.length === 0) return null
  const first = drops[0] as { path?: string; reason?: string }
  return `${first.path ?? 'messages'}: the thinking block's ${first.reason === 'model_binding_mismatch' ? 'model' : 'prefix'} binding does not match this request (${first.reason ?? 'binding_mismatch'}); set thinking.block_binding.prefix_mismatch_behavior to "drop_block" to drop it instead`
}

export function boundSignature(body: { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string }): string {
  return `${BOUND_SIGNATURE_PREFIX}${prefixHashOf(body, Array.isArray(body.messages) ? body.messages : [])}:${String(body.model ?? '')}`
}

export function bindingDropsFor(current: unknown): unknown[] {
  const cur = current as { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string } | null
  if (!cur || !Array.isArray(cur.messages)) return []
  const dropped: unknown[] = []
  let broken = false
  cur.messages.forEach((message, i) => {
    const row = message as { role?: string; content?: unknown }
    if (row.role !== 'assistant' || !Array.isArray(row.content)) return
    row.content.forEach((block, j) => {
      const b = block as { type?: string; signature?: unknown }
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') return
      if (typeof b.signature !== 'string' || !b.signature.startsWith(BOUND_SIGNATURE_PREFIX)) return
      if (broken) {
        dropped.push({ type: 'thinking_dropped', path: `messages.${i}.content.${j}`, reason: 'prefix_binding_mismatch' })
        return
      }
      const [, mintedHash, mintedModel] = b.signature.split(':')
      if (mintedModel !== String(cur.model ?? '')) {
        dropped.push({ type: 'thinking_dropped', path: `messages.${i}.content.${j}`, reason: 'model_binding_mismatch' })
        broken = true
        return
      }
      if (mintedHash !== prefixHashOf(cur, cur.messages!.slice(0, i))) {
        dropped.push({ type: 'thinking_dropped', path: `messages.${i}.content.${j}`, reason: 'prefix_binding_mismatch' })
        broken = true
      }
    })
  })
  return dropped
}

function maxOutputTokensCap(model: string): number {
  const id = model.toLowerCase()
  if (id.includes('haiku-4-5')) return 64_000
  return 128_000
}

export function apiRefusalOf(body: unknown): string | null {
  const request = body as { model?: string; max_tokens?: number; messages?: unknown[] } | null
  if (!request || !Array.isArray(request.messages)) return null
  const messages = request.messages as Array<{ role?: string; content?: unknown }>
  if (messages.length === 0) return 'messages: at least one message is required'
  if (messages[0]!.role !== 'user') return 'messages: first message must use the "user" role'
  const cap = maxOutputTokensCap(String(request.model ?? ''))
  if (typeof request.max_tokens === 'number' && request.max_tokens > cap) {
    return `max_tokens: ${request.max_tokens} > ${cap}, which is the maximum allowed number of output tokens for ${String(request.model)}`
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const final = i === messages.length - 1
    const content = message.content
    if (message.role === 'assistant') {
      if (Array.isArray(content) && content.length === 0 && !final) {
        return `messages.${i}: all messages must have non-empty content except for the optional final assistant message`
      }
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type?: string; signature?: unknown; id?: string }>
        const last = blocks[blocks.length - 1]
        if (!final && last !== undefined && (last.type === 'thinking' || last.type === 'redacted_thinking')) {
          return `messages.${i}: assistant message must not end with a thinking block`
        }
        for (let j = 0; j < blocks.length; j++) {
          const block = blocks[j]!
          if (block.type === 'thinking' && typeof block.signature !== 'string') {
            return `messages.${i}.content.${j}: thinking block is missing its signature`
          }
          if (block.type === 'tool_use') {
            const next = messages[i + 1]
            const results = Array.isArray(next?.content) ? (next!.content as Array<{ type?: string; tool_use_id?: string }>) : []
            if (!results.some(r => r.type === 'tool_result' && r.tool_use_id === block.id)) {
              return `messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after: ${String(block.id)}. Each tool_use block must have a corresponding tool_result block in the next message.`
            }
          }
        }
      }
    }
  }
  return null
}

export async function startFixtureApi(
  turns: ScriptedTurn[],
  opts?: {
    apiChecks?: boolean
    destroyOnKeepAliveReuse?: boolean
    bindingCheck?: boolean
    messageHeaders?: Record<string, string>
    jsonForNonStream?: boolean
  },
): Promise<FixtureApi> {
  const queue = [...turns]
  const requests: CapturedRequest[] = []
  const usage: UsageEndpointControl = { mode: 'ok', status: 500, payload: () => ({}) }
  const usageRequests: FixtureApi['usageRequests'] = []
  const refusals: { request: number; message: string }[] = []
  const messagesServedBySocket = new WeakMap<object, number>()
  let destroyedReplays = 0
  const pacedEmits: FixtureApi['pacedEmits'] = []
  const toolEmits: FixtureApi['toolEmits'] = []
  const streamEmits: FixtureApi['streamEmits'] = []
  let msgSeq = 0
  let clientAborted = false
  const started = new Map<number, () => void>()
  const startedPromises = new Map<number, Promise<void>>()
  const openResponses = new Set<import('node:http').ServerResponse>()

  const startedPromise = (n: number): Promise<void> => {
    let p = startedPromises.get(n)
    if (!p) {
      p = new Promise<void>(resolve => started.set(n, resolve))
      startedPromises.set(n, p)
    }
    return p
  }

  const server: Server = createServer((req, res) => {
    if (opts?.destroyOnKeepAliveReuse && (req.url ?? '').includes('/v1/messages')) {
      const served = messagesServedBySocket.get(req.socket) ?? 0
      if (served >= 1) {
        destroyedReplays++
        req.socket.destroy()
        return
      }
      messagesServedBySocket.set(req.socket, served + 1)
    }
    const rawChunks: Buffer[] = []
    req.on('data', c => rawChunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(rawChunks).toString('utf8')
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { unparseable: raw.slice(0, 200) }
      }
      const headers: Record<string, string> = {}
      for (const name of ['anthropic-beta', 'anthropic-version', 'user-agent', 'x-app', 'content-type']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      requests.push({ path: req.url ?? '', method: req.method ?? '', headers, body, raw })

      if ((req.url ?? '').includes('/api/oauth/usage')) {
        const n = usageRequests.length + 1
        usage.next?.(n)
        usageRequests.push({ at: Date.now(), mode: usage.mode, n })
        if (usage.mode === 'hang') {
          openResponses.add(res)
          req.socket.on('close', () => openResponses.delete(res))
          return
        }
        if (usage.mode === 'error') {
          res.writeHead(usage.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `fixture usage endpoint answered ${usage.status}` } }))
          return
        }
        const bearer = req.headers.authorization
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(usage.payload(n, typeof bearer === 'string' ? bearer : undefined)))
        return
      }

      if (!(req.url ?? '').includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }

      msgSeq++
      for (const [name, value] of Object.entries(opts?.messageHeaders ?? {})) res.setHeader(name, value)
      const requestedModel =
        typeof (body as { model?: unknown })?.model === 'string'
          ? ((body as { model: string }).model)
          : ''
      let pick = queue.findIndex(
        candidate => candidate.whenModel !== undefined && requestedModel.includes(candidate.whenModel),
      )
      if (pick === -1) {
        pick = queue.findIndex(candidate => candidate.whenModel === undefined)
      }
      let turn = pick === -1 ? undefined : queue.splice(pick, 1)[0]
      if (opts?.apiChecks) {
        const refusal = apiRefusalOf(body)
        if (refusal !== null) {
          if (turn !== undefined) queue.unshift(turn)
          refusals.push({ request: msgSeq, message: refusal })
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: refusal } }))
          return
        }
      }
      if (opts?.bindingCheck && turn !== undefined && (turn.kind === 'text' || turn.kind === 'tool_use')) {
        const judged = turn.inputTransformations === undefined ? bindingDropsFor(body) : turn.inputTransformations
        const refusal = bindingRefusalOf(body, judged)
        if (refusal !== null) {
          queue.unshift(turn)
          refusals.push({ request: msgSeq, message: refusal })
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: refusal } }))
          return
        }
        turn = {
          ...turn,
          signature: boundSignature(body as { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string }),
          ...(turn.inputTransformations === undefined ? { inputTransformations: judged } : {}),
        }
      }
      started.get(msgSeq)?.()
      void startedPromise(msgSeq)
      started.get(msgSeq)?.()

      if (!turn) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'fixture script exhausted — the run made more model turns than scripted',
            },
          }),
        )
        return
      }
      if (turn.kind === 'error') {
        res.writeHead(turn.status, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: turn.errorType, message: turn.message },
          }),
        )
        return
      }
      if (opts?.jsonForNonStream && turn.kind === 'text' && (body as { stream?: unknown })?.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: `msg_fixture_${msgSeq}`,
            type: 'message',
            role: 'assistant',
            model: turn.model ?? requestedModel,
            content: [{ type: 'text', text: turn.text }],
            stop_reason: turn.stopReason ?? 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: turn.usage?.input_tokens ?? 25, output_tokens: turn.usage?.output_tokens ?? 12 },
          }),
        )
        return
      }
      const writeSseHead = (): void => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        })
      }
      const holdsHeaders =
        (turn.kind === 'paced' && turn.startDelayMs) ||
        (turn.kind === 'stream' && turn.headerDelayMs)
      if (!holdsHeaders) writeSseHead()
      if (turn.kind === 'hang') {
        openResponses.add(res)
        res.write(messageStart(`msg_fixture_${msgSeq}`))
        res.write(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        )
        for (const d of turn.deltas ?? []) {
          res.write(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: d },
            }),
          )
        }
        const markAborted = (): void => {
          clientAborted = true
          openResponses.delete(res)
        }
        res.on('close', markAborted)
        res.on('error', markAborted)
        req.socket.on('close', markAborted)
        req.socket.on('error', markAborted)
        return
      }
      if (turn.kind === 'die') {
        res.write(messageStart(`msg_fixture_${msgSeq}`))
        res.write(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        )
        for (const d of turn.deltas ?? []) {
          res.write(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: d },
            }),
          )
        }
        res.destroy()
        return
      }
      if (turn.kind === 'paced_tool_use') {
        const turnNo = msgSeq
        openResponses.add(res)
        res.write(messageStart(`msg_fixture_${msgSeq}`))
        res.write(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        )
        let i = 0
        const tick = setInterval(() => {
          if (res.destroyed || res.socket?.destroyed) {
            clearInterval(tick)
            openResponses.delete(res)
            return
          }
          if (i >= turn.preDeltas.length) {
            clearInterval(tick)
            res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
            turn.tools.forEach((tool, ti) => {
              const id = tool.id ?? `toolu_fixture_${turnNo}_${ti}`
              res.write(toolUseBlocks(id, tool.name, tool.input, ti + 1))
              toolEmits.push({ turn: turnNo, name: tool.name, id, at: Date.now() })
            })
            res.end(messageEnd('tool_use'))
            openResponses.delete(res)
            return
          }
          const text = turn.preDeltas[i]!
          try {
            res.write(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              }),
            )
            pacedEmits.push({ turn: turnNo, index: i, text, at: Date.now() })
          } catch {
            clearInterval(tick)
            openResponses.delete(res)
            return
          }
          i++
        }, turn.gapMs)
        return
      }
      if (turn.kind === 'stream') {
        const turnNo = msgSeq
        type PlannedChunk = {
          payload: string
          emit?: { blockIndex: number; blockType: 'thinking' | 'text'; index: number; text: string }
        }
        const chunks: PlannedChunk[] = [
          { payload: messageStart(`msg_fixture_${msgSeq}`, turn.usage) },
        ]
        turn.blocks.forEach((block, bi) => {
          chunks.push({
            payload:
              block.type === 'thinking'
                ? thinkingBlockStart(bi)
                : sseEvent('content_block_start', {
                    type: 'content_block_start',
                    index: bi,
                    content_block: { type: 'text', text: '' },
                  }),
          })
          block.deltas.forEach((text, di) => {
            chunks.push({
              payload:
                block.type === 'thinking'
                  ? thinkingDelta(bi, text)
                  : sseEvent('content_block_delta', {
                      type: 'content_block_delta',
                      index: bi,
                      delta: { type: 'text_delta', text },
                    }),
              emit: { blockIndex: bi, blockType: block.type, index: di, text },
            })
          })
          if (block.type === 'thinking') chunks.push({ payload: signatureDelta(bi) })
          chunks.push({
            payload: sseEvent('content_block_stop', { type: 'content_block_stop', index: bi }),
          })
        })
        const pump = (): void => {
          openResponses.add(res)
          let i = 0
          const tick = setInterval(() => {
            if (res.destroyed || res.socket?.destroyed) {
              clearInterval(tick)
              openResponses.delete(res)
              return
            }
            if (i >= chunks.length) {
              clearInterval(tick)
              res.end(messageEnd(turn.stopReason ?? 'end_turn', turn.usage))
              openResponses.delete(res)
              return
            }
            const chunk = chunks[i]!
            try {
              res.write(chunk.payload)
              if (chunk.emit) streamEmits.push({ turn: turnNo, ...chunk.emit, at: Date.now() })
            } catch {
              clearInterval(tick)
              openResponses.delete(res)
              return
            }
            i++
          }, turn.gapMs)
        }
        const startBody = (): void => {
          if (turn.firstChunkDelayMs) {
            res.flushHeaders()
            const hold = setTimeout(() => {
              if (res.destroyed || res.socket?.destroyed) return
              pump()
            }, turn.firstChunkDelayMs)
            hold.unref?.()
          } else {
            pump()
          }
        }
        if (turn.headerDelayMs) {
          const hold = setTimeout(() => {
            if (res.destroyed || res.socket?.destroyed) return
            writeSseHead()
            startBody()
          }, turn.headerDelayMs)
          hold.unref?.()
        } else {
          startBody()
        }
        return
      }
      if (turn.kind === 'paced') {
        const turnNo = msgSeq
        const serve = (): void => {
        openResponses.add(res)
        res.write(messageStart(`msg_fixture_${msgSeq}`))
        res.write(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        )
        let i = 0
        const tick = setInterval(() => {
          if (res.destroyed || res.socket?.destroyed) {
            clearInterval(tick)
            openResponses.delete(res)
            return
          }
          if (i >= turn.deltas.length) {
            clearInterval(tick)
            const finish = (): void => {
              if (res.destroyed || res.socket?.destroyed) {
                openResponses.delete(res)
                return
              }
              res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }))
              res.end(messageEnd(turn.stopReason ?? 'end_turn'))
              openResponses.delete(res)
            }
            if (turn.settleDelayMs) {
              const hold = setTimeout(finish, turn.settleDelayMs)
              hold.unref?.()
            } else {
              finish()
            }
            return
          }
          const text = turn.deltas[i]!
          try {
            res.write(
              sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              }),
            )
            pacedEmits.push({ turn: turnNo, index: i, text, at: Date.now() })
          } catch {
            clearInterval(tick)
            openResponses.delete(res)
            return
          }
          i++
        }, turn.gapMs)
        }
        if (turn.startDelayMs) {
          const hold = setTimeout(() => {
            if (res.destroyed || res.socket?.destroyed) return
            writeSseHead()
            serve()
          }, turn.startDelayMs)
          hold.unref?.()
        } else {
          serve()
        }
        return
      }

      res.end(renderTurn(turn, msgSeq))
    })
  })

  if (process.env.FIXTURE_DEBUG) {
    let cn = 0
    server.on('connection', socket => {
      const id = ++cn
      console.error(`[fixture] conn#${id} open`)
      socket.once('data', (b: Buffer) =>
        console.error(`[fixture] conn#${id} first-bytes: ${JSON.stringify(b.subarray(0, 120).toString('utf8'))}`),
      )
      socket.on('close', () => console.error(`[fixture] conn#${id} closed`))
    })
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    usage,
    usageRequests,
    pacedEmits,
    toolEmits,
    streamEmits,
    messageRequests: () => requests.filter(r => r.path.includes('/v1/messages')),
    refusals,
    destroyedReplays: () => destroyedReplays,
    messageRequestStarted: startedPromise,
    sawClientAbort: () => clientAborted,
    close: async () => {
      for (const res of openResponses) res.destroy()
      openResponses.clear()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
