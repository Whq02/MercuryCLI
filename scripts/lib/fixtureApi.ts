
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

export interface FixtureApi {
  port: number
  url: string
  requests: CapturedRequest[]
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

function signatureDelta(index: number): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature: 'fixture-signature' },
  })
}

function signedThinkingBlock(index: number, text: string): string {
  return (
    thinkingBlockStart(index) +
    thinkingDelta(index, text) +
    signatureDelta(index) +
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
        body += signedThinkingBlock(index, turn.thinking)
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
        body += signedThinkingBlock(index, turn.thinking)
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

export async function startFixtureApi(
  turns: ScriptedTurn[],
  opts?: {
    destroyOnKeepAliveReuse?: boolean
  },
): Promise<FixtureApi> {
  const queue = [...turns]
  const requests: CapturedRequest[] = []
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

      if (!(req.url ?? '').includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }

      msgSeq++
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
      const turn = pick === -1 ? undefined : queue.splice(pick, 1)[0]
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
          clearInterval(heartbeat)
          openResponses.delete(res)
        }
        res.on('close', markAborted)
        res.on('error', markAborted)
        req.socket.on('close', markAborted)
        req.socket.on('error', markAborted)
        const heartbeat = setInterval(() => {
          if (res.destroyed || res.socket?.destroyed) {
            markAborted()
            return
          }
          try {
            res.write(': hb\n\n')
          } catch {
            markAborted()
          }
        }, 250)
        heartbeat.unref?.()
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
    pacedEmits,
    toolEmits,
    streamEmits,
    messageRequests: () => requests.filter(r => r.path.includes('/v1/messages')),
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
