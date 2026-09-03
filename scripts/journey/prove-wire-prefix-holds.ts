#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-wire-prefix-holds.ts — the sent prefix holds on the
//  wire across every operator action of one real-terminal session.
//
//  Claude Fable 5.1 binds every thinking block to the exact prefix that
//  produced it (system, tools, every earlier message). This drive boots the
//  BUILT bundle in a PTY against a fixture API that plays the binding law and
//  walks sessions through what a tester does. The fixture records every
//  request; the replay tool (scripts/api/wire-prefix-replay.ts) names, for
//  every consecutive pair, the first byte that moved.
//
//    LEG 1 — the operator's actions: born in apollo; a tool lookup, a shell
//            command, a second lookup, /subagents off, shift+tab to flow, a
//            plain turn, /compact, a turn after the fold. The law: every pair
//            HOLDS except across the compaction (the head rewritten lawfully,
//            one receipt), no dropped thinking anywhere else, never the
//            "Mercury defect" arm.
//    LEG 2 — the model round trip: born in flow; two lookups, /model to
//            Opus 5 and "continue", a mode switch to implement, /model back
//            to Fable 5.1, two more turns. The law: every pair HOLDS except
//            the two model-switch pairs, the fixture refuses nothing (the
//            client never sends an illegal shape), no dropped thinking, and
//            the Opus turn answers — a turn that sits with no stream events
//            is recorded as what the client did next.
//
//  THE FIXTURE is this same file, hosted under NODE as its own process
//  (`--serve <capture> <model>`): bun's node:http shim never raises close on
//  a mid-stream drop, and a PTY child cannot connect back into a server
//  socket held by the prover process. It is content-routed (what it answers
//  depends on the request it reads, never on a queue position) and plays the
//  API's own laws instead of scripting outcomes:
//    · every thinking block it streams carries a signature bound to the
//      request prefix that produced it (a hash of system + tools + messages,
//      cache_control stripped); a replayed block whose prefix no longer
//      hashes the same is dropped with every thinking block after it, and
//      message_start.input_transformations names each one — exactly what
//      the drop classifier and the operator's notice read;
//    · usage.cache_read_input_tokens is the previous conversation request's
//      prefix length when that request is a byte-identical prefix of this
//      one and 0 when it is not (the prompt cache's own reading, in the
//      fixture's unit: bytes / 4, so a whole context never reads as a full
//      window to the gauge);
//    · an illegal request is refused as the API refuses it — a 400 with the
//      invalid_request_error shape — for the shapes the API documents:
//      temperature on a 5-family model, an empty assistant turn, an empty
//      text block, a tool_use without its result or a result without its
//      use, a beta-gated field without its header, a foreign or unsigned
//      thinking signature on a request that carries no binding field, a
//      non-adaptive thinking mode or a forced tool choice on Fable.
//      The capture records the refusal; the client's next request shows
//      what it did with it.
//
//  Modes:
//    default    prove — asserts the laws above, exit 1 on any breach
//    --report   evidence only — prints the same tables and the product's
//               own word (debug log, transcript notices, doctor ledger),
//               asserts only that the drives completed; the BEFORE/AFTER
//               instrument for a fix under review
//
//  Requires dist/mercury.mjs (bun run build.ts) and the capture driver
//  (scripts/lib/captureDriver.ts: the system python with pyte). Run:
//    ~/.bun/bin/bun run scripts/journey/prove-wire-prefix-holds.ts [--report]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import {
  comparePrefix,
  conversationRows,
  debugLogWord,
  doctorLedgerWord,
  isSummariserRequest,
  keptHeaders,
  printReport,
  readCapture,
  transcriptNotices,
  withoutCacheControl,
  type CaptureRow,
  type PairReport,
  type WireBody,
} from '../api/wire-prefix-replay.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DIST = path.join(REPO, 'dist', 'mercury.mjs')

/** The model the seat runs; the fixture answers this id as the conversation. */
const MODEL = 'claude-fable-5-1'
/** The model the round trip switches to. */
const OTHER_MODEL = 'claude-opus-5'
const TOOL_SEARCH = 'ToolSearch'
const BASH = 'Bash'
const SUMMARY_TEXT = 'Summary of the session so far: five fixture turns — two tool lookups, one shell command, one plain turn — nothing left open.'
/** The deferred tools the lookups prefer, in order; the announcement row decides what exists. */
const PREFERRED_LOOKUPS = ['WebFetch', 'NotebookEdit', 'WebSearch', 'Monitor', 'StructureTool']

// ============================================================================
//  The fixture (node): the Anthropic dialect, content-routed, the API's laws
// ============================================================================

type Block = Record<string, unknown>
type Row = { role?: string; content?: unknown }
type Reply =
  | { kind: 'text'; text: string; thinking: string | null }
  | { kind: 'tool_use'; name: string; input: Record<string, unknown>; thinking: string }

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** The bytes a thinking block binds to: system, tools and every message before the new turn. */
function canonicalPrefix(body: WireBody, upToMessage?: number): string {
  const messages = (body.messages ?? []) as unknown[]
  return JSON.stringify(
    withoutCacheControl({
      system: body.system ?? null,
      tools: body.tools ?? [],
      messages: upToMessage === undefined ? messages : messages.slice(0, upToMessage),
    }),
  )
}

/** Text blocks of a row (never a tool result's inner text). */
function rowText(row: Row | undefined): string {
  if (row === undefined) return ''
  if (typeof row.content === 'string') return row.content
  if (!Array.isArray(row.content)) return ''
  return (row.content as Block[])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => String(b.text))
    .join('\n')
}

/** The turn the newest prompt names ("wire-prefix turn N"), 0 when none. */
function currentTurn(messages: Row[]): number {
  for (let k = messages.length - 1; k >= 0; k--) {
    if (messages[k]?.role !== 'user') continue
    const m = /wire-prefix turn (\d)/.exec(rowText(messages[k]))
    if (m) return Number(m[1])
  }
  return 0
}

/** The deferred tools the request announces: the tagged name-only row, or
 *  the persisted delta reminder ("now available via ToolSearch") — whichever
 *  form this wire carries. */
function announcedDeferredNames(messages: Row[]): string[] {
  const names: string[] = []
  const take = (list: string): void => {
    for (const name of list.split('\n').map(s => s.trim()).filter(s => s !== '')) {
      if (!names.includes(name)) names.push(name)
    }
  }
  for (const row of messages) {
    if (row.role !== 'user') continue
    const text = rowText(row)
    const tagged = /<available-deferred-tools>\n([\s\S]*?)\n<\/available-deferred-tools>/.exec(text)
    if (tagged) take(tagged[1]!)
    const delta = /deferred tools are now available via ToolSearch:\n([\s\S]*?)\n<\/system-reminder>/g
    let m: RegExpExecArray | null
    while ((m = delta.exec(text)) !== null) take(m[1]!)
  }
  return names
}

function pickLookup(deferred: string[], ordinal: number): string {
  const preferred = PREFERRED_LOOKUPS.filter(name => deferred.includes(name))
  if (preferred.length > ordinal) return preferred[ordinal]!
  const rest = deferred.filter(name => !preferred.includes(name) && !name.startsWith('mcp__'))
  const fromRest = rest[ordinal - preferred.length]
  return fromRest ?? PREFERRED_LOOKUPS[ordinal] ?? 'WebFetch'
}

function toolUseName(messages: Row[], toolUseId: string): string {
  for (let k = messages.length - 1; k >= 0; k--) {
    const row = messages[k]!
    if (row.role !== 'assistant' || !Array.isArray(row.content)) continue
    for (const block of row.content as Block[]) {
      if (block.type === 'tool_use' && block.id === toolUseId) return String(block.name ?? '?')
    }
  }
  return '?'
}

/** What the conversation answers, read off the request alone. */
function route(body: WireBody): Reply {
  const messages = (body.messages ?? []) as Row[]
  const last = messages[messages.length - 1]
  const model = String(body.model ?? '')
  const tag = model.includes('opus') ? 'OPUS-' : ''
  if (isSummariserRequest(body)) return { kind: 'text', text: SUMMARY_TEXT, thinking: null }
  const turn = currentTurn(messages)
  const results = Array.isArray(last?.content) ? (last!.content as Block[]).filter(b => b.type === 'tool_result') : []
  if (results.length > 0) {
    const name = toolUseName(messages, String(results[0]!.tool_use_id ?? ''))
    return { kind: 'text', text: `${tag}TURN-${turn}-DONE after ${name}`, thinking: `the ${name} round of turn ${turn} is in` }
  }
  const lastText = rowText(last).trim()
  if (/^continue\b/i.test(lastText)) return { kind: 'text', text: `${tag}CONTINUED`, thinking: 'carrying on' }
  const deferred = announcedDeferredNames(messages)
  switch (turn) {
    case 1:
      return { kind: 'tool_use', name: TOOL_SEARCH, input: { query: `select:${pickLookup(deferred, 0)}` }, thinking: 'turn 1: look a deferred tool up' }
    case 2:
      return { kind: 'tool_use', name: BASH, input: { command: 'echo wire-prefix-echo', description: 'Echo a marker' }, thinking: 'turn 2: run the echo' }
    case 3:
      return { kind: 'tool_use', name: TOOL_SEARCH, input: { query: `select:${pickLookup(deferred, 1)}` }, thinking: 'turn 3: a second lookup' }
    case 4:
      return { kind: 'text', text: `${tag}TURN-4-DONE plain`, thinking: 'turn 4: plain' }
    case 5:
      return { kind: 'text', text: `${tag}TURN-5-DONE after`, thinking: 'turn 5' }
    default:
      return { kind: 'text', text: `${tag}TURN-${turn}-DONE`, thinking: `turn ${turn}` }
  }
}

type Drop = { type: 'thinking_dropped'; path: string; reason: 'prefix_binding_mismatch' | 'model_binding_mismatch' }

/**
 * THE BINDING LAW: a replayed thinking block is kept only when the prefix
 * before it hashes to what its signature recorded; the first failing block
 * and every thinking block after it are dropped and named.
 */
function dropsFor(body: WireBody): Drop[] {
  const messages = (body.messages ?? []) as Row[]
  const model = String(body.model ?? '')
  const out: Drop[] = []
  let broken = false
  for (let k = 0; k < messages.length; k++) {
    const row = messages[k]!
    if (row.role !== 'assistant' || !Array.isArray(row.content)) continue
    const content = row.content as Block[]
    for (let j = 0; j < content.length; j++) {
      const block = content[j]!
      if (block.type !== 'thinking') continue
      const path = `messages.${k}.content.${j}`
      if (broken) {
        out.push({ type: 'thinking_dropped', path, reason: 'prefix_binding_mismatch' })
        continue
      }
      const m = /^wt1:([^:]+):([0-9a-f]{64})$/.exec(String(block.signature ?? ''))
      let reason: Drop['reason'] | null = null
      if (m === null || j !== 0) reason = 'prefix_binding_mismatch'
      else if (m[1] !== model) reason = 'model_binding_mismatch'
      else if (sha256(canonicalPrefix(body, k)) !== m[2]) reason = 'prefix_binding_mismatch'
      if (reason !== null) {
        out.push({ type: 'thinking_dropped', path, reason })
        broken = true
      }
    }
  }
  return out
}

const isFiveFamily = (model: string): boolean => /claude-[a-z]+-5(\b|-)/.test(model) || /opus-4-(7|8|9)/.test(model)
const isFable = (model: string): boolean => /fable-5|mythos-5/.test(model)

/**
 * THE VALIDATION LAW: the shapes the API refuses, with its message. Null
 * when the request is legal. Read from the documented 400s: temperature on
 * a 5-family model (and Opus 4.7+), an empty assistant turn, an empty text
 * block, tool_use ids without their results (or results without a use),
 * a beta-gated field without its header, a foreign or unsigned thinking
 * signature on a request carrying no binding field, a non-adaptive thinking
 * mode or a forced tool choice on Fable.
 */
function validate(body: WireBody, betaHeader: string): string | null {
  const model = String(body.model ?? '')
  const messages = (body.messages ?? []) as Row[]
  if ('temperature' in body && body.temperature !== undefined && isFiveFamily(model)) {
    return 'temperature: `temperature` is deprecated for this model'
  }
  const thinking = body.thinking as { type?: string; block_binding?: unknown } | undefined
  if (isFable(model) && thinking !== undefined && thinking.type !== 'adaptive') {
    return 'thinking: adaptive thinking is the only mode for this model'
  }
  const toolChoice = body.tool_choice as { type?: string } | undefined
  if (isFable(model) && toolChoice !== undefined && (toolChoice.type === 'any' || toolChoice.type === 'tool')) {
    return 'tool_choice: forced tool choice is not supported for this model'
  }
  if (thinking?.block_binding !== undefined && !betaHeader.includes('thinking-binding-controls')) {
    return 'thinking.block_binding: Extra inputs are not permitted'
  }
  const tools = Array.isArray(body.tools) ? (body.tools as Block[]) : []
  for (let i = 0; i < tools.length; i++) {
    if (tools[i]!.defer_loading !== undefined && !betaHeader.includes('advanced-tool-use')) {
      return `tools.${i}.defer_loading: Extra inputs are not permitted`
    }
  }
  if (messages.length > 0 && messages[0]!.role !== 'user') return 'messages: first message must use the "user" role'
  for (let k = 0; k < messages.length; k++) {
    const row = messages[k]!
    const content = row.content
    if (Array.isArray(content) && content.length === 0 && !(k === messages.length - 1 && row.role === 'assistant')) {
      return `messages.${k}: all messages must have non-empty content except for the optional final assistant message`
    }
    if (typeof content === 'string' && content === '') {
      return `messages.${k}.content: text content blocks must be non-empty`
    }
    if (!Array.isArray(content)) continue
    const blocks = content as Block[]
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j]!
      if (block.type === 'text' && String(block.text ?? '').trim() === '') {
        return `messages.${k}.content.${j}.text: text content blocks must be non-empty`
      }
      if (block.type === 'thinking' && thinking?.block_binding === undefined) {
        const m = /^wt1:([^:]+):[0-9a-f]{64}$/.exec(String(block.signature ?? ''))
        if (m === null || m[1] !== model) return `messages.${k}.content.${j}: Invalid \`signature\` in \`thinking\` block`
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = block.content as Block[]
        for (let i = 0; i < inner.length; i++) {
          if (inner[i]!.type === 'tool_reference' && !betaHeader.includes('advanced-tool-use')) {
            return `messages.${k}.content.${j}.content.${i}: Extra inputs are not permitted`
          }
        }
      }
    }
    if (row.role === 'assistant') {
      const uses = blocks.filter(b => b.type === 'tool_use').map(b => String(b.id))
      if (uses.length > 0 && k < messages.length - 1) {
        const next = messages[k + 1]!
        const answered = new Set(
          Array.isArray(next.content) ? (next.content as Block[]).filter(b => b.type === 'tool_result').map(b => String(b.tool_use_id)) : [],
        )
        const missing = uses.filter(id => !answered.has(id))
        if (missing.length > 0) return `messages.${k}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}`
      }
    }
    if (row.role === 'user') {
      const previous = k > 0 ? messages[k - 1]! : undefined
      const known = new Set(
        previous !== undefined && Array.isArray(previous.content) ? (previous.content as Block[]).filter(b => b.type === 'tool_use').map(b => String(b.id)) : [],
      )
      for (let j = 0; j < blocks.length; j++) {
        const block = blocks[j]!
        if (block.type === 'tool_result' && !known.has(String(block.tool_use_id))) {
          return `messages.${k}.content.${j}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(block.tool_use_id)}`
        }
      }
    }
  }
  return null
}

function renderReply(
  reply: Reply,
  opts: { id: string; model: string; usage: Record<string, number>; drops: Drop[]; signature: string },
): string {
  let index = 0
  let body = sse('message_start', {
    type: 'message_start',
    message: {
      id: opts.id,
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      ...(opts.drops.length > 0 ? { input_transformations: opts.drops } : {}),
      usage: { ...opts.usage, output_tokens: 1 },
    },
  })
  if (reply.thinking !== null) {
    body += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
    body += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reply.thinking } })
    body += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: opts.signature } })
    body += sse('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  if (reply.kind === 'text') {
    body += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    body += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: reply.text } })
    body += sse('content_block_stop', { type: 'content_block_stop', index })
  } else {
    body += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${opts.id}`, name: reply.name, input: {} } })
    body += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } })
    body += sse('content_block_stop', { type: 'content_block_stop', index })
  }
  body += sse('message_delta', { type: 'message_delta', delta: { stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } })
  body += sse('message_stop', { type: 'message_stop' })
  return body
}

/** A request that is not the conversation: a one-row prompt with no tools
 *  (a title, a classifier), whatever its model. */
function isSideRequest(body: WireBody): boolean {
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  const messages = Array.isArray(body.messages) ? body.messages.length : 0
  return tools === 0 && messages <= 1 && !isSummariserRequest(body)
}

function serve(captureFile: string, mainModel: string): void {
  let seq = 0
  let previous: WireBody | null = null
  const record = (row: CaptureRow): void => appendFileSync(captureFile, `${JSON.stringify(row)}\n`)
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { type: 'model', id: mainModel, display_name: 'Claude Fable 5.1', created_at: '2026-08-01T00:00:00Z' },
              { type: 'model', id: OTHER_MODEL, display_name: 'Claude Opus 5', created_at: '2026-08-01T00:00:00Z' },
            ],
            has_more: false,
          }),
        )
        return
      }
      if (url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 1000 }))
        return
      }
      if (!(req.method === 'POST' && url.includes('/messages'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: WireBody
      try {
        body = JSON.parse(raw) as WireBody
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'unparseable body' } }))
        return
      }
      seq++
      const at = Date.now()
      const model = String(body.model ?? '')
      const id = `msg_wt_${seq}`
      const headers = keptHeaders(req.headers as Record<string, string | string[] | undefined>)
      const side = isSideRequest(body)
      // The validation law first: an illegal shape is refused whatever the
      // request was for, and the refusal is the record.
      const refusal = validate(body, headers['anthropic-beta'] ?? '')
      if (refusal !== null) {
        record({ kind: 'request', seq, at, url, model, headers, body, response: { status: 400, error: refusal, model, ms: 0 } })
        res.writeHead(400, { 'content-type': 'application/json', 'request-id': `req_wt_${seq}` })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: refusal } }))
        return
      }
      if (side) {
        const usage = { input_tokens: 25, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        record({ kind: 'request', seq, at, url, model, headers, body, response: { status: 200, usage, text: 'side', model } })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_wt_${seq}` })
        res.end(renderReply({ kind: 'text', text: 'fixture side reply', thinking: null }, { id, model, usage, drops: [], signature: '' }))
        return
      }
      // The conversation: the binding law, the cache law, the routed reply.
      const drops = dropsFor(body)
      const verdict = previous === null ? null : comparePrefix(previous, body)
      const prefixBytes = previous === null ? 0 : Buffer.byteLength(canonicalPrefix(previous))
      const bytes = Buffer.byteLength(canonicalPrefix(body))
      const cacheRead = verdict !== null && verdict.held ? Math.ceil(prefixBytes / 4) : 0
      const usage = {
        input_tokens: 25,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: Math.max(0, Math.ceil(bytes / 4) - cacheRead),
      }
      const reply = route(body)
      const signature = `wt1:${model}:${sha256(canonicalPrefix(body))}`
      previous = body
      record({
        kind: 'request',
        seq,
        at,
        url,
        model,
        headers,
        body,
        response: {
          status: 200,
          usage,
          input_transformations: drops,
          text: reply.kind === 'text' ? reply.text : `${reply.name} ${JSON.stringify(reply.input)}`,
          model,
          ...({ prefix_bytes: prefixBytes, bytes, held: verdict === null ? null : verdict.held, first_diff: verdict?.diff?.path ?? null } as Record<string, unknown>),
        },
      })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_wt_${seq}` })
      res.end(renderReply(reply, { id, model, usage, drops, signature }))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    console.log(`PORT ${typeof address === 'object' && address ? address.port : 0}`)
  })
}

if (process.argv[2] === '--serve') {
  const captureFile = process.argv[3]
  if (!captureFile) {
    console.error('usage: prove-wire-prefix-holds.ts --serve <captureFile> [model]')
    process.exit(2)
  }
  serve(captureFile, process.argv[4] ?? MODEL)
} else {
  await drive()
}

// ============================================================================
//  The drive (bun): PTY sessions on the built bundle
// ============================================================================

type Send = { atTick: number; minTick?: number; afterPrevTicks?: number; awaitText?: string; awaitSettleTicks?: number; data: string; mark?: string }
type Grid = Array<Array<{ c: string }>>
type Payload = { grid: Grid; sendReceipts?: Array<{ atTick?: number }>; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
type Leg = {
  name: string
  payload: Payload | null
  status: number | null
  stderr: string
  captureFile: string
  debugFile: string
  fired: number[]
  deadlines: number[]
  seconds: number
  finalGrid: string
  markGrid(label: string): string
}
// A function declaration: it is hoisted above the top-level drive() call.
function gridText(grid: Grid): string {
  return grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}

async function drive(): Promise<void> {
  const REPORT = process.argv.includes('--report')
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

  if (!existsSync(DIST)) {
    console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT bundle)')
    process.exit(1)
  }
  const driver = resolveCaptureDriver()
  if (driver.kind === 'unavailable') {
    console.log(`FAIL no capture driver: ${driver.reason} — ${driver.remedy}`)
    process.exit(1)
  }

  // ── the hermetic world ──────────────────────────────────────────────────
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-wire-prefix-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-wire-prefix-probe-key'
  rmSync(RUN_HOME, { recursive: true, force: true })
  mkdirSync(FIXTURE_CWD, { recursive: true })
  writeFileSync(
    path.join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  // The shell command runs without a consent card: the rule the tester's
  // own settings would carry.
  writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(echo:*)'] } }))
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# wire prefix drive fixture\n')

  const fixtures: ChildProcess[] = []
  const reap = (): void => {
    for (const fixture of fixtures) {
      try {
        fixture.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    // A red run (and every report run) KEEPS the world for forensics.
    if (failures === 0 && !REPORT) {
      try {
        rmSync(RUN_HOME, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    } else {
      console.log(`[forensics] world kept: ${RUN_HOME}`)
    }
  }
  process.on('exit', reap)

  // HOME stays the operator's: the capture engine's python resolves its
  // user site-packages (pyte) from it; the product's home is the config
  // home below, pinned outright.
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: PROBE_KEY,
    // The fixture host is not first-party: the explicit values put the
    // binding field and the block-form deferral on this wire, exactly as
    // the first-party contract does by itself.
    MERCURY_THINKING_BINDING: 'drop_block',
    MERCURY_TOOL_SEARCH: 'on',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
    MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
    MERCURY_TABULA_MINERVA: '0',
  }
  delete baseEnv.NODE_ENV
  delete baseEnv.ANTHROPIC_AUTH_TOKEN
  delete baseEnv.OPENAI_API_KEY
  delete baseEnv.MERCURY_TOOL_DEFER_PROBE
  delete baseEnv.MERCURY_WIRE_DUMP

  /** One PTY session against its own fixture process; the capture and the debug log per leg. */
  async function runLeg(name: string, mode: string, sends: Send[], total: number, readyText: string): Promise<Leg> {
    const captureFile = path.join(RUN_HOME, `wire-capture-${name}.jsonl`)
    writeFileSync(captureFile, '')
    const fixture = spawn('node', [fileURLToPath(import.meta.url), '--serve', captureFile, MODEL], { stdio: ['ignore', 'pipe', 'pipe'] })
    fixtures.push(fixture)
    let fixtureStderr = ''
    fixture.stderr?.on('data', (chunk: Buffer) => (fixtureStderr += chunk.toString('utf8')))
    const port = await new Promise<number>((resolve, reject) => {
      const killer = setTimeout(() => reject(new Error(`fixture server never printed PORT (${fixtureStderr.slice(0, 300)})`)), 20_000)
      let buffer = ''
      fixture.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const m = /PORT (\d+)/.exec(buffer)
        if (m) {
          clearTimeout(killer)
          resolve(Number(m[1]))
        }
      })
      fixture.on('exit', code => reject(new Error(`fixture server exited early (${code}) ${fixtureStderr.slice(0, 300)}`)))
    }).catch(err => {
      console.log(`FAIL ${String(err)}`)
      process.exit(1)
    })
    const debugFile = path.join(RUN_HOME, `${name}.debug.log`)
    const out = path.join(RUN_HOME, `grid-${name}.json`)
    const cfg = {
      argv: ['node', DIST, '--model', MODEL, '--permission-mode', mode, '--debug-file', debugFile],
      cwd: FIXTURE_CWD,
      sends,
      readyText: [readyText],
      stableTicks: 4,
      total,
      cols: 120,
      rows: 40,
      out,
    }
    const cfgPath = path.join(RUN_HOME, `cfg-${name}.json`)
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const startedAt = Date.now()
    const res = spawnSync(driver.python, [captureEngineEntry(driver, REPO), cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(total * 200 + 40_000),
      cwd: FIXTURE_CWD,
      env: { ...baseEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
    })
    const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
    return {
      name,
      payload,
      status: res.status,
      stderr: res.stderr ?? '',
      captureFile,
      debugFile,
      fired: sends.map((_, i) => payload?.sendReceipts?.[i]?.atTick ?? -1),
      deadlines: sends.map(s => s.atTick),
      seconds: Math.round((Date.now() - startedAt) / 1000),
      finalGrid: payload ? gridText(payload.grid) : '',
      markGrid: (label: string): string => {
        const mark = payload?.marks?.find(m => m.label === label)
        return mark ? gridText(mark.grid) : ''
      },
    }
  }

  const sessionFiles = (): string[] => walk(path.join(RUN_HOME, 'projects')).filter(f => f.endsWith('.jsonl'))

  const driveReport = (leg: Leg, sends: Send[]): void => {
    check(`${leg.name}: vshot exited 0 with a grid`, leg.status === 0 && leg.payload !== null, `status=${leg.status} stderr=${leg.stderr.slice(-400)}`)
    console.log(`  ${leg.name}: sends fired at ticks ${leg.fired.join(', ')} (deadlines ${leg.deadlines.join(', ')}); ended: ${leg.payload?.endReason ?? '?'} after ${leg.seconds}s`)
    // Every send delivered (fired > 0). "Fired on its await, before its
    // deadline" is a drive-health signal, not the law under proof — a loaded
    // box boots slowly and pushes an await past a tight tick — so it prints
    // in both modes; the law is the WIRE (asserted below), which a blind
    // fire would corrupt and the wire assertions would then catch.
    for (let i = 1; i < sends.length; i++) {
      const send = sends[i]!
      check(`${leg.name}: send ${i} delivered`, leg.fired[i]! > 0, `fired at ${leg.fired[i]}`)
      if (send.awaitText === undefined) continue
      const onAwait = leg.fired[i]! > 0 && leg.fired[i]! < leg.deadlines[i]!
      console.log(`    ${leg.name}: send ${i} (${send.awaitText}) fired at ${leg.fired[i]} ${onAwait ? 'on its await' : `on its DEADLINE ${leg.deadlines[i]} (the await never painted — a slow boot or a stall)`}`)
    }
  }

  const productWord = (leg: Leg): { word: string[]; notices: string[]; ledger: string | null } => {
    const word = debugLogWord(leg.debugFile)
    for (const line of word) console.log(`  debug: ${line.slice(0, 300)}`)
    const notices = sessionFiles().flatMap(transcriptNotices)
    for (const notice of notices) console.log(`  notice: ${notice.slice(0, 300)}`)
    const ledger = doctorLedgerWord(RUN_HOME)
    console.log(`  doctor ledger: ${ledger ?? 'none written'}`)
    return { word, notices, ledger }
  }

  console.log('============================================================')
  console.log(` wire prefix ${REPORT ? 'REPORT' : 'PROOF'} — the built bundle in a PTY, the API's laws on the fixture wire`)
  console.log('============================================================')

  // ── LEG 1: the operator's actions ───────────────────────────────────────
  // Sends (each fires on its await; its atTick is the HARD deadline):
  //   [0] ↵ on New Session (the bare boot lands on the Boot face)
  //   [1] turn 1 — the fixture answers a ToolSearch lookup, then the reply
  //   [2] turn 2 — a Bash call (pre-allowed), then the reply
  //   [3] turn 3 — a second lookup
  //   [4] /subagents off — the spawn-switch toggle
  //   [5] shift+tab — Apollo → Flow (the seat was born in apollo)
  //   [6] turn 4 — plain
  //   [7] /compact — the manual fold
  //   [8] turn 5 — after the fold
  // Deadlines are generous and monotonic: a latched await fires the send
  // the tick its text paints, so the drive runs at real latency (and ends
  // early on readyText); the high deadline only prevents a blind fire when
  // a slow boot pushes the await past a tight tick (leg-1 boot was fast, but
  // a loaded box is not guaranteed one).
  const sends1: Send[] = [
    { atTick: 180, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
    { atTick: 520, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 3, data: 'wire-prefix turn 1: find a deferred tool\r', mark: 'chat' },
    { atTick: 700, minTick: 10, awaitText: 'TURN-1-DONE', awaitSettleTicks: 4, data: 'wire-prefix turn 2: run the echo\r', mark: 't1' },
    { atTick: 820, minTick: 10, awaitText: 'TURN-2-DONE', awaitSettleTicks: 4, data: 'wire-prefix turn 3: find another deferred tool\r', mark: 't2' },
    { atTick: 940, minTick: 10, awaitText: 'TURN-3-DONE', awaitSettleTicks: 4, data: '/subagents off\r', mark: 't3' },
    { atTick: 1000, minTick: 5, awaitText: 'sub-agents off', awaitSettleTicks: 3, data: '\x1b[Z', mark: 'toggle' },
    { atTick: 1060, minTick: 5, awaitText: 'flow on', awaitSettleTicks: 3, data: 'wire-prefix turn 4: plain\r', mark: 'flow' },
    { atTick: 1180, minTick: 10, awaitText: 'TURN-4-DONE', awaitSettleTicks: 4, data: '/compact\r', mark: 't4' },
    { atTick: 1320, minTick: 10, awaitText: 'Compacted', awaitSettleTicks: 4, data: 'wire-prefix turn 5: after the fold\r', mark: 'compact' },
  ]
  section('1D — leg 1 (the operator\'s actions): the drive completed')
  const leg1 = await runLeg('actions', 'apollo', sends1, 1440, 'TURN-5-DONE')
  driveReport(leg1, sends1)
  check('leg 1: the fifth reply painted on the final screen (TURN-5-DONE)', leg1.finalGrid.includes('TURN-5-DONE'), leg1.finalGrid.split('\n').slice(-16).join('\n'))
  check('leg 1: the fold painted its boundary row', leg1.finalGrid.includes('Compacted') || leg1.markGrid('compact').includes('Compacted'))

  section('1W — leg 1: every consecutive pair of the conversation, the first byte that moved')
  const rows1 = readCapture(leg1.captureFile)
  const stream1 = conversationRows(rows1)
  const pairs1 = printReport(rows1)
  const lookups1 = stream1.filter(r => (r.response?.text ?? '').startsWith(TOOL_SEARCH))
  const admissions1 = stream1.filter(r => JSON.stringify((r.body as WireBody).messages ?? []).includes('"tool_reference"'))
  console.log(`  lookups answered: ${lookups1.map(r => r.response?.text).join(' · ') || 'none'}; requests carrying an admission record: ${admissions1.length}`)
  check('leg 1: at least nine conversation requests (five turns, three tool rounds, the summariser)', stream1.length >= 9, String(stream1.length))
  check('leg 1: two lookups, both admitting a tool (a tool_reference record rides the later requests)', lookups1.length === 2 && admissions1.length >= 1, `lookups=${lookups1.length} admissions=${admissions1.length}`)
  check('leg 1: the shell command ran (a Bash tool_result rides a later request)', stream1.some(r => JSON.stringify((r.body as WireBody).messages ?? []).includes('wire-prefix-echo')))

  section('1P — leg 1: the product\'s own word beside the wire')
  const word1 = productWord(leg1)

  // ── LEG 2: the model round trip ─────────────────────────────────────────
  // Sends:
  //   [0] ↵ on New Session
  //   [1] turn 1 — a lookup (born in flow)
  //   [2] turn 3 — a second lookup
  //   [3] /model claude-opus-5
  //   [4] "continue" — 8 ticks after the switch (the chip flips at once)
  //   [5] shift+tab — flow → default; fires when OPUS-CONTINUED painted, or
  //       at its DEADLINE when the turn sat with no stream events (the
  //       tester's stall) — the mark records the screen either way
  //   [6] shift+tab — default → implement (default paints no band: a gap)
  //   [7] turn 4 on Opus, once implement is on
  //   [8] /model claude-fable-5-1
  //   [9] turn 5 — back on Fable, 8 ticks after the switch
  //  [10] turn 6 — once more
  const sends2: Send[] = [
    { atTick: 180, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
    { atTick: 520, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 3, data: 'wire-prefix turn 1: find a deferred tool\r', mark: 'chat' },
    { atTick: 700, minTick: 10, awaitText: 'TURN-1-DONE', awaitSettleTicks: 4, data: 'wire-prefix turn 3: find another deferred tool\r', mark: 't1' },
    { atTick: 880, minTick: 10, awaitText: 'TURN-3-DONE', awaitSettleTicks: 4, data: `/model ${OTHER_MODEL}\r`, mark: 't3' },
    { atTick: 900, afterPrevTicks: 8, data: 'continue\r', mark: 'switched-opus' },
    // OPUS-CONTINUED paints on a compliant wire; if it never does (the
    // tester's stall), this fires on its deadline — the mode switch that
    // "unsticks it" — and the mark records the stalled screen either way.
    { atTick: 1120, minTick: 5, awaitText: 'OPUS-CONTINUED', awaitSettleTicks: 4, data: '\x1b[Z', mark: 'opus-continue' },
    // Flow → default paints no band, so the second cycle rides a fixed gap.
    { atTick: 1160, afterPrevTicks: 6, data: '\x1b[Z', mark: 'to-default' },
    { atTick: 1260, minTick: 5, awaitText: 'implement mode on', awaitSettleTicks: 3, data: 'wire-prefix turn 4: on the other model\r', mark: 'implement' },
    { atTick: 1440, minTick: 10, awaitText: 'OPUS-TURN-4-DONE', awaitSettleTicks: 4, data: `/model ${MODEL}\r`, mark: 'opus-t4' },
    { atTick: 1460, afterPrevTicks: 8, data: 'wire-prefix turn 5: back on the first model\r', mark: 'switched-back' },
    { atTick: 1600, minTick: 10, awaitText: 'TURN-5-DONE', awaitSettleTicks: 4, data: 'wire-prefix turn 6: once more\r', mark: 't5' },
  ]
  section('2D — leg 2 (the model round trip): the drive completed')
  const leg2 = await runLeg('roundtrip', 'flow', sends2, 1760, 'TURN-6-DONE')
  driveReport(leg2, sends2)
  check('leg 2: the seat was born in flow (the band says so at the first prompt)', leg2.markGrid('chat').includes('flow on'), leg2.markGrid('chat').split('\n').filter(l => l.includes(' on')).join(' | ').slice(0, 200))
  check('leg 2: the sixth reply painted on the final screen (TURN-6-DONE)', leg2.finalGrid.includes('TURN-6-DONE'), leg2.finalGrid.split('\n').slice(-16).join('\n'))
  const opusContinueGrid = leg2.markGrid('opus-continue')
  const opusAnswered = leg2.fired[5]! > 0 && leg2.fired[5]! < leg2.deadlines[5]!
  const stallLines = opusContinueGrid.split('\n').filter(l => /no stream events|stuck|thinking|0 tokens|requesting/i.test(l)).map(l => l.trim()).slice(0, 4)
  console.log(`  leg 2: the Opus turn ${opusAnswered ? 'answered before the mode switch' : 'had NOT answered when the mode switch fired (the deadline)'}; screen then: ${stallLines.join(' | ') || 'nothing stall-shaped'}`)

  section('2W — leg 2: every consecutive pair of the conversation, the first byte that moved')
  const rows2 = readCapture(leg2.captureFile)
  const stream2 = conversationRows(rows2)
  const pairs2 = printReport(rows2)
  const refused2 = stream2.filter(r => r.response?.status !== undefined && r.response.status !== 200)
  const opusRows = stream2.filter(r => String((r.body as WireBody).model ?? '').includes('opus'))
  console.log(`  leg 2: ${opusRows.length} request(s) to ${OTHER_MODEL}; refused: ${refused2.length}${refused2.length ? ` (${refused2.map(r => `#${r.seq} ${r.response?.error}`).join(' | ')})` : ''}`)
  for (const r of opusRows.slice(0, 2)) {
    const body = r.body as WireBody
    console.log(`  leg 2: to ${OTHER_MODEL} #${r.seq}: thinking=${JSON.stringify(body.thinking)} tools=${Array.isArray(body.tools) ? body.tools.length : 0} messages=${Array.isArray(body.messages) ? body.messages.length : 0} betas=${r.headers?.['anthropic-beta'] ?? '?'}`)
  }
  check('leg 2: the switch reached the wire (at least one request to the other model) and the way back (a later request to the first model)', opusRows.length >= 1 && stream2.some(r => (r.seq ?? 0) > (opusRows[opusRows.length - 1]!.seq ?? 0) && String((r.body as WireBody).model ?? '') === MODEL), `opus=${opusRows.length}`)

  section('2P — leg 2: the product\'s own word beside the wire')
  const word2 = productWord(leg2)

  // ── the law ─────────────────────────────────────────────────────────────
  section(REPORT ? 'T — the tables (report mode asserts nothing here)' : 'L — the law')
  const tally = (label: string, pairs: PairReport[]): { unlawful: PairReport[]; lawful: PairReport[] } => {
    const unlawful = pairs.filter(p => !p.verdict.held && p.lawful === null && !p.retry)
    const lawful = pairs.filter(p => !p.verdict.held && p.lawful !== null)
    console.log(`  ${label}: ${pairs.length} pairs — ${pairs.filter(p => p.verdict.held).length} held · ${lawful.length} moved on a lawful change (${lawful.map(p => p.lawful).join(', ') || 'none'}) · ${unlawful.length} rewrote sent history`)
    for (const p of unlawful) console.log(`    rewrite: #${p.prevSeq}→#${p.curSeq} at ${p.verdict.diff?.path}`)
    return { unlawful, lawful }
  }
  const t1 = tally('leg 1', pairs1)
  const t2 = tally('leg 2', pairs2)
  if (!REPORT) {
    check('leg 1: every pair outside the compaction holds (no rewrite of sent history)', t1.unlawful.length === 0, t1.unlawful.map(p => `#${p.prevSeq}→#${p.curSeq} ${p.verdict.diff?.path}`).join(' | '))
    check('leg 1: the compaction is the only prefix move (the summariser and the post-compaction head)', t1.lawful.length >= 1 && t1.lawful.length <= 2 && t1.lawful.every(p => p.lawful === 'compaction'), t1.lawful.map(p => `#${p.prevSeq}→#${p.curSeq} ${p.lawful}`).join(' | '))
    const unlawfulDrops1 = stream1.filter(r => (r.response?.input_transformations?.length ?? 0) > 0 && !pairs1.some(p => p.curSeq === r.seq && p.lawful !== null))
    check('leg 1: the API dropped no thinking outside the compaction', unlawfulDrops1.length === 0, unlawfulDrops1.map(r => `#${r.seq} ${r.response?.input_transformations?.[0]?.path}`).join(' | '))
    check('leg 1: the operator never read the "Mercury defect" arm', !word1.notices.some(n => n.includes('Mercury defect')) && !(word1.ledger ?? '').includes('recurrent'), word1.notices.join(' | ').slice(0, 300))
    const cacheZero1 = pairs1.filter(p => p.lawful === null && p.cacheRead === 0)
    check('leg 1: the prompt cache read the prefix on every held pair (cache_read > 0 outside the compaction)', cacheZero1.length === 0, cacheZero1.map(p => `#${p.prevSeq}→#${p.curSeq}`).join(' | '))

    check('leg 2: every pair outside the two model switches holds', t2.unlawful.length === 0, t2.unlawful.map(p => `#${p.prevSeq}→#${p.curSeq} ${p.verdict.diff?.path}`).join(' | '))
    check('leg 2: the model switches are the only prefix moves', t2.lawful.every(p => p.lawful === 'model-switch') && t2.lawful.length <= 2, t2.lawful.map(p => `#${p.prevSeq}→#${p.curSeq} ${p.lawful}`).join(' | '))
    check('leg 2: the fixture refused nothing (the client never sent an illegal shape)', refused2.length === 0, refused2.map(r => `#${r.seq} ${r.response?.error}`).join(' | '))
    const drops2 = stream2.filter(r => (r.response?.input_transformations?.length ?? 0) > 0)
    check('leg 2: the API dropped no thinking (the other model\'s blocks stay out, the first model\'s prefixes hold)', drops2.length === 0, drops2.map(r => `#${r.seq} ${r.response?.input_transformations?.[0]?.path}`).join(' | '))
    check('leg 2: the Opus turn answered before the mode switch (no stall on a compliant wire)', opusAnswered, stallLines.join(' | '))
    check('leg 2: the operator never read the "Mercury defect" arm', !word2.notices.some(n => n.includes('Mercury defect')), word2.notices.join(' | ').slice(0, 300))
  }

  if (failures > 0 || REPORT) {
    for (const leg of [leg1, leg2]) {
      console.log(`\n[forensics] ${leg.name} capture: ${leg.captureFile}`)
      console.log(`[forensics] replay:  node scripts/api/wire-prefix-replay.ts ${leg.captureFile} --debug-file ${leg.debugFile} --home ${RUN_HOME}`)
    }
    if (failures > 0) {
      console.log(`[forensics] leg 2 final screen:\n${leg2.finalGrid.split('\n').slice(-20).join('\n')}`)
    }
  }
  console.log(`\n ${checks} checks, ${failures} failures`)
  process.exit(failures === 0 ? 0 : 1)
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    try {
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else out.push(full)
    } catch {
      // vanished
    }
  }
  return out
}
