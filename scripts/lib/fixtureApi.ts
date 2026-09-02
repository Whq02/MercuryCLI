// scripts/lib/fixtureApi.ts — a deterministic local Anthropic-API fixture
// server for the core-ownership program's REAL-ARTIFACT golden journeys
// (scripts/ownership/prove-runtime-journeys.ts and later domain oracles).
//
// Why this works: src/services/api/client.ts constructs `new Anthropic(...)`
// without an explicit baseURL, so the SDK's own env default applies —
// ANTHROPIC_BASE_URL routes the SHIPPED dist/mercury.mjs to this server with
// zero source seams. Feasibility proven: a hermetic
// `-p` run against this fixture returned the scripted text byte-exact.
//
// The server scripts /v1/messages responses as an ordered queue of turns.
// Every request is captured (path, headers subset, parsed body) for wire-
// contract assertions. Non-message paths (the SDK's `/` reachability probe)
// answer 200 empty so boot-time probes never hang a journey.

import { createServer, type Server } from 'node:http'

/** PULSE: optional usage override for a scripted turn — the autocompact scene
 *  needs the REPORTED input_tokens to approach the window so the next submit
 *  genuinely trips the threshold. Absent ⇒ the historic 25/12 constants, so
 *  every existing fixture stays byte-identical. */
export type FixtureUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** One scripted response. `whenModel` restricts a turn to
 *  requests whose model id CONTAINS that substring: a UI journey that wants a
 *  long streaming turn from the main loop must not have it eaten by the
 *  haiku-class side call the same submit fires. Turns without `whenModel`
 *  answer anything, FIFO — so every existing script is unchanged. */
export type ScriptedTurn = ScriptedTurnBody & { whenModel?: string }

type ScriptedTurnBody =
  /** `thinking` (text and tool_use turns): a SIGNED thinking block streamed
   *  first — the real wire's shape when adaptive thinking is on — so a
   *  journey's transcript carries replayable thinking for the
   *  transcript-binding provers. Absent ⇒ byte-identical to before. */
  | {
      kind: 'text'
      text: string
      stopReason?: string
      usage?: FixtureUsage
      thinking?: string
      /** The drop list the message_start envelope carries (the
       *  preserved-thinking controls); absent ⇒ no field. */
      inputTransformations?: unknown[]
    }
  | {
      kind: 'tool_use'
      name: string
      input: Record<string, unknown>
      id?: string
      preText?: string
      thinking?: string
      inputTransformations?: unknown[]
    }
  | { kind: 'error'; status: number; errorType: string; message: string }
  /** Streams `deltas` then HOLDS the connection open (cancellation journeys). */
  | { kind: 'hang'; deltas: string[] }
  /** FLUX: streams one text_delta per entry, gapMs apart, then settles.
   *  Each write's wall time is recorded in FixtureApi.pacedEmits — the
   *  provider-side emit clock for visibility-latency benches.
   *  startDelayMs: hold the ENTIRE response (headers too)
   *  for this long first — a real REQUESTING-mode window for cadence
   *  measurement. settleDelayMs: hold the TERMINAL frames (block/message
   *  stop) after the last delta — a fully-painted-but-unsettled window that
   *  isolates the settle swap. */
  | { kind: 'paced'; deltas: string[]; gapMs: number; stopReason?: string; startDelayMs?: number; settleDelayMs?: number }
  /** FLUX S9: streams `deltas` then DESTROYS the socket mid-stream (no
   *  message_stop, no clean close — the provider died mid-paragraph). */
  | { kind: 'die'; deltas: string[] }
  /** Streams paced text deltas (recorded in pacedEmits),
   *  then one tool_use block per `tools` entry, then message_stop with
   *  stop_reason tool_use. Each tool block's wall-clock emit lands in
   *  FixtureApi.toolEmits — the provider-side clock for card-appear
   *  latency measurement. */
  | {
      kind: 'paced_tool_use'
      preDeltas: string[]
      gapMs: number
      tools: { name: string; input: Record<string, unknown>; id?: string }[]
    }
  /** PULSE (scene matrix): a typed block stream — thinking-first / text-first
   *  ordering plus the two provider-delay controls the perf laws need.
   *  `headerDelayMs` holds EVERYTHING (headers too — scene 7: provider delay
   *  before headers); `firstChunkDelayMs` writes the SSE headers immediately
   *  and holds the FIRST BODY BYTE (scene 8: headers→first-chunk gap). Deltas
   *  stream `gapMs` apart; each delta's wall-clock emit lands in
   *  FixtureApi.streamEmits. Thinking blocks emit thinking_delta frames and a
   *  trailing signature_delta (the real wire shape). */
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
  /** The provider-relevant request headers (lower-cased names): the beta
   *  list, the API version, the user agent and the app stamp — the
   *  transcript-binding capture reads the beta list off every request. */
  headers: Record<string, string>
  body: unknown
  raw: string
}

/**
 * CONSUMPTION CONTRACT (decided at the re-audit, not inherited):
 * scripts are deliberately SLACK-PROVISIONED — a run may consume fewer turns
 * than scripted (side-call counts vary by timing), so `close()` does NOT
 * assert leftovers and never will by default. The corollary: a prover whose
 * claim is "this call HAPPENED" must assert it positively from `requests`/
 * `messageRequests()` (count, model, body shape) — a vanished side call is
 * invisible to every other signal.
 */
export interface FixtureApi {
  port: number
  url: string
  requests: CapturedRequest[]
  /** Per-delta provider emit log for `paced` turns (wall-clock Date.now). */
  pacedEmits: { turn: number; index: number; text: string; at: number }[]
  /** Per-tool-block emit log for `paced_tool_use` turns (wall-clock). */
  toolEmits: { turn: number; name: string; id: string; at: number }[]
  /** Per-delta emit log for `stream` turns (wall-clock; PULSE matrix). */
  streamEmits: {
    turn: number
    blockIndex: number
    blockType: 'thinking' | 'text'
    index: number
    text: string
    at: number
  }[]
  /** Message-endpoint requests only (the SDK also probes `/`). */
  messageRequests(): CapturedRequest[]
  /** Replays destroyed under `destroyOnKeepAliveReuse` (headless-deadline
   *  lane): how many message requests arrived on a socket that had already
   *  served one and were killed pre-response — the server-closed keep-alive
   *  replay, observed from the server side. */
  destroyedReplays(): number
  /** Resolves when the Nth (1-based) message request has STARTED streaming. */
  messageRequestStarted(n: number): Promise<void>
  /**
   * True once the client aborted a still-open (hanging) response.
   * BEST-EFFORT under Bun: its node:http server parks the socket after
   * request-end on a streaming response, so a client FIN can sit unobserved
   * in CLOSE_WAIT (Phase 0 finding). Prefer asserting the abort by its
   * reliable consequences — prompt process exit + no follow-up request.
   */
  sawClientAbort(): boolean
  close(): Promise<void>
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(id: string, usage?: FixtureUsage, inputTransformations?: unknown[]): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8', // fixed mock-wire exemplar (response-shape data, not a seat default)
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // The preserved-thinking controls' drop list rides the message_start
      // envelope on the real wire; scripted per turn, absent by default.
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

/** Thinking content-block frames (`stream` turns): thinking_delta deltas plus
 *  the trailing signature_delta the real wire carries. */
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

/** One complete signed thinking block: start, one thinking_delta, the
 *  signature_delta, stop — what a text/tool_use turn streams first when
 *  its script carries `thinking`. */
function signedThinkingBlock(index: number, text: string): string {
  return (
    thinkingBlockStart(index) +
    thinkingDelta(index, text) +
    signatureDelta(index) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index })
  )
}

/** Render a scripted turn to a complete SSE body (except `hang`). */
export function renderTurn(turn: ScriptedTurn, msgSeq: number): string {
  const id = `msg_fixture_${msgSeq}`
  switch (turn.kind) {
    case 'text': {
      let body = messageStart(id, turn.usage, turn.inputTransformations)
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
      let body = messageStart(id, undefined, turn.inputTransformations)
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
      body += messageEnd('tool_use')
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
    /** Kill the SECOND message request that arrives on one keep-alive socket
     *  by destroying the socket before any response bytes — the
     *  server-closed-keep-alive replay (B3.5). Scoped to /v1/messages so the
     *  SDK's `/` probes neither trip it nor shield it. */
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
    // Bytes FIRST, decode ONCE (the pulse root cause): `raw += c`
    // decoded each Buffer chunk separately, so a multi-byte UTF-8 sequence
    // split across socket chunk boundaries (the prompt's em dash) decoded
    // to replacement chars on SOME runs — an intermittent ±1-char payload
    // that read as "pool-load flake" in the equivalence digests.
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
      // Model-routed pick: a turn that names a model waits for that model; the
      // first unrestricted turn answers everything else (plain FIFO when no
      // script uses whenModel).
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
      // Pre-create the promise so late subscribers see an already-resolved one.
      void startedPromise(msgSeq)
      started.get(msgSeq)?.()

      if (!turn) {
        // 400 (non-retryable) — a 500 here sends the SDK into retry backoff
        // and turns a script gap into a silent multi-second hang (observed
        // Phase 0: the evidence-based stop evaluator's continuation turn).
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
      // paced+startDelayMs / stream+headerDelayMs hold the WHOLE response
      // (headers too) — a real requesting-mode window; everything else
      // answers immediately.
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
        // …and hold. The client tearing this down is the observation. Under
        // Bun's node:http compat the server does NOT reliably emit 'close'
        // for a client-dead socket (observed Phase 0) — detect the FIN by
        // HEARTBEAT WRITES instead: SSE comment frames every 250ms; the
        // first write after teardown errors (EPIPE/RST) and flips the flag.
        const markAborted = (): void => {
          clientAborted = true
          clearInterval(heartbeat)
          openResponses.delete(res)
        }
        res.on('close', markAborted)
        res.on('error', markAborted)
        // The reliable signal under Bun: the RAW net.Socket emits 'close'
        // when the client dies; the http response wrapper does not.
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
        // Mid-stream provider death: RST the socket, no terminal frames.
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
        // Flatten to one write per tick: message_start, block frames (each
        // delta its own tick), signature (thinking), stops, terminal frames.
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
        // headerDelayMs holds EVERYTHING (scene 7); firstChunkDelayMs writes
        // the headers now and holds the first body byte (scene 8). Both may
        // combine (headers after A ms, first chunk B ms later).
        const startBody = (): void => {
          if (turn.firstChunkDelayMs) {
            // writeHead only BUFFERS — without a flush the header bytes sit
            // until the first body write and the scene degenerates into a
            // header delay. Flush so the client really sees headers now.
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
            // settleDelayMs: hold the terminal frames so
            // the app sits FULLY PAINTED but unsettled — the window that
            // isolates the settle swap from ordinary stream growth.
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

  // FIXTURE_DEBUG=1: log raw connection opens + first bytes to stderr —
  // discriminates "client never sent" from "server never parsed".
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
