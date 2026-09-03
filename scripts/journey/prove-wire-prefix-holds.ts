#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-wire-prefix-holds.ts — the sent prefix holds on the wire
//  across every operator action of one real-terminal session.
//
//  Claude Fable 5.1 binds every thinking block to the exact prefix that
//  produced it (system, tools, every earlier message). This drive boots the
//  BUILT bundle in a PTY against a fixture API that plays the binding law and
//  walks one session through everything a tester does: a tool lookup, a
//  shell command, a second lookup, the sub-agents toggle, the Apollo → Flow
//  mode switch, a plain turn, a manual compaction, a turn after the fold. The
//  fixture records every request and the replay tool
//  (scripts/api/wire-prefix-replay.ts) names, for every consecutive pair, the
//  first byte that moved. The law under proof: every pair HOLDS (the earlier
//  request is a byte-identical prefix of the later one) except across the
//  compaction, which rewrites the head lawfully — one receipt, never the
//  "Mercury defect" arm, and no dropped thinking anywhere else.
//
//  THE FIXTURE is this same file, hosted under NODE as its own process
//  (`--serve <capture> <model>`): bun's node:http shim never raises close on
//  a mid-stream drop, and a PTY child cannot connect back into a server
//  socket held by the prover process. It is content-routed (what it answers
//  depends on the request it reads, never on a queue position) and it
//  implements the API's own laws instead of scripting outcomes:
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
//      window to the gauge).
//
//  Modes:
//    default    prove — asserts the law above, exit 1 on any unlawful pair
//    --report   evidence only — prints the same table and the product's own
//               word (debug log, transcript notices, doctor ledger), asserts
//               only that the drive completed; the BEFORE/AFTER comparison
//               tool for a fix under review
//
//  Requires dist/mercury.mjs (bun run build.ts) and /usr/bin/python3 with
//  pyte (the render-verify capture substrate). Run:
//    ~/.bun/bin/bun run scripts/journey/prove-wire-prefix-holds.ts [--report]
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
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
  type WireBody,
} from '../api/wire-prefix-replay.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DIST = path.join(REPO, 'dist', 'mercury.mjs')

/** The model the seat runs; the fixture answers this id as the conversation. */
const MODEL = 'claude-fable-5-1'
const TOOL_SEARCH = 'ToolSearch'
const BASH = 'Bash'
const SUMMARY_TEXT = 'Summary of the session so far: five fixture turns — two tool lookups, one shell command, one plain turn — nothing left open.'
/** The deferred tools the lookups prefer, in order; the announcement row decides what exists. */
const PREFERRED_LOOKUPS = ['WebFetch', 'NotebookEdit', 'WebSearch', 'Monitor', 'StructureTool']

// ============================================================================
//  The fixture (node): the Anthropic dialect, content-routed, the binding law
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

/** The turn the newest prompt names ("wire-truth turn N"), 0 when none. */
function currentTurn(messages: Row[]): number {
  for (let k = messages.length - 1; k >= 0; k--) {
    if (messages[k]?.role !== 'user') continue
    const m = /wire-truth turn (\d)/.exec(rowText(messages[k]))
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
  if (isSummariserRequest(body)) return { kind: 'text', text: SUMMARY_TEXT, thinking: null }
  const turn = currentTurn(messages)
  const results = Array.isArray(last?.content) ? (last!.content as Block[]).filter(b => b.type === 'tool_result') : []
  if (results.length > 0) {
    const name = toolUseName(messages, String(results[0]!.tool_use_id ?? ''))
    return { kind: 'text', text: `TURN-${turn}-DONE after ${name}`, thinking: `the ${name} round of turn ${turn} is in` }
  }
  const deferred = announcedDeferredNames(messages)
  switch (turn) {
    case 1:
      return { kind: 'tool_use', name: TOOL_SEARCH, input: { query: `select:${pickLookup(deferred, 0)}` }, thinking: 'turn 1: look a deferred tool up' }
    case 2:
      return { kind: 'tool_use', name: BASH, input: { command: 'echo wire-truth-echo', description: 'Echo a marker' }, thinking: 'turn 2: run the echo' }
    case 3:
      return { kind: 'tool_use', name: TOOL_SEARCH, input: { query: `select:${pickLookup(deferred, 1)}` }, thinking: 'turn 3: a second lookup' }
    case 4:
      return { kind: 'text', text: 'TURN-4-DONE plain', thinking: 'turn 4: plain' }
    case 5:
      return { kind: 'text', text: 'TURN-5-DONE after the fold', thinking: 'turn 5: after the fold' }
    default:
      return { kind: 'text', text: `TURN-${turn}-DONE`, thinking: `turn ${turn}` }
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

/** A request that is not the conversation: another model, or a one-row prompt with no tools. */
function isSideRequest(body: WireBody, mainModel: string): boolean {
  const model = String(body.model ?? '')
  if (model !== mainModel) return true
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
        res.end(JSON.stringify({ data: [{ type: 'model', id: mainModel, display_name: 'Claude Fable 5.1', created_at: '2026-08-01T00:00:00Z' }], has_more: false }))
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
      if (isSideRequest(body, mainModel)) {
        const usage = { input_tokens: 25, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        record({ kind: 'request', seq, at, url, model, headers, body, response: { usage, text: 'side', model } })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
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
          usage,
          input_transformations: drops,
          text: reply.kind === 'text' ? reply.text : `${reply.name} ${JSON.stringify(reply.input)}`,
          model,
          ...({ prefix_bytes: prefixBytes, bytes, held: verdict === null ? null : verdict.held, first_diff: verdict?.diff?.path ?? null } as Record<string, unknown>),
        },
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
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
//  The drive (bun): one PTY session on the built bundle
// ============================================================================

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

  // ── the hermetic world ──────────────────────────────────────────────────
  const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-wire-truth-${process.pid}`)
  const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-wire-truth-probe-key'
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
  writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# wire truth drive fixture\n')

  // ── the fixture server (its own process, under node) ────────────────────
  const captureFile = path.join(RUN_HOME, 'wire-capture.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn('node', [fileURLToPath(import.meta.url), '--serve', captureFile, MODEL], { stdio: ['ignore', 'pipe', 'pipe'] })
  let fixtureStderr = ''
  fixture.stderr.on('data', (chunk: Buffer) => (fixtureStderr += chunk.toString('utf8')))
  const port = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error(`fixture server never printed PORT (${fixtureStderr.slice(0, 300)})`)), 20_000)
    let buffer = ''
    fixture.stdout.on('data', (chunk: Buffer) => {
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
  const base = `http://127.0.0.1:${port}`

  const reap = (): void => {
    try {
      fixture.kill('SIGTERM')
    } catch {
      /* already gone */
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

  console.log('============================================================')
  console.log(` wire prefix ${REPORT ? 'REPORT' : 'PROOF'} — the built bundle in a PTY, the binding law on the fixture wire`)
  console.log('============================================================')

  // ── the PTY drive ───────────────────────────────────────────────────────
  type Send = { atTick: number; minTick?: number; awaitText?: string; awaitSettleTicks?: number; data: string; mark?: string }
  type Grid = Array<Array<{ c: string }>>
  type Payload = { grid: Grid; sendReceipts?: Array<{ atTick?: number }>; marks?: Array<{ label: string; atTick: number; grid: Grid }>; endReason?: string }
  const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

  const debugFile = path.join(RUN_HOME, 'session.debug.log')
  // HOME stays the operator's: the capture engine's python resolves its
  // user site-packages (pyte) from it; the product's home is the config
  // home below, pinned outright.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: RUN_HOME,
    MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: base,
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
  delete childEnv.NODE_ENV
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.OPENAI_API_KEY
  delete childEnv.MERCURY_TOOL_DEFER_PROBE

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
  const sends: Send[] = [
    { atTick: 60, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r' },
    { atTick: 140, minTick: 10, awaitText: '? for shortcuts', awaitSettleTicks: 3, data: 'wire-truth turn 1: find a deferred tool\r', mark: 'chat' },
    { atTick: 260, minTick: 10, awaitText: 'TURN-1-DONE', awaitSettleTicks: 4, data: 'wire-truth turn 2: run the echo\r', mark: 't1' },
    { atTick: 380, minTick: 10, awaitText: 'TURN-2-DONE', awaitSettleTicks: 4, data: 'wire-truth turn 3: find another deferred tool\r', mark: 't2' },
    { atTick: 500, minTick: 10, awaitText: 'TURN-3-DONE', awaitSettleTicks: 4, data: '/subagents off\r', mark: 't3' },
    { atTick: 540, minTick: 5, awaitText: 'sub-agents off', awaitSettleTicks: 3, data: '\x1b[Z', mark: 'toggle' },
    { atTick: 570, minTick: 5, awaitText: 'flow on', awaitSettleTicks: 3, data: 'wire-truth turn 4: plain\r', mark: 'flow' },
    { atTick: 680, minTick: 10, awaitText: 'TURN-4-DONE', awaitSettleTicks: 4, data: '/compact\r', mark: 't4' },
    { atTick: 800, minTick: 10, awaitText: 'Compacted', awaitSettleTicks: 4, data: 'wire-truth turn 5: after the fold\r', mark: 'compact' },
  ]
  const TOTAL = 900
  const out = path.join(RUN_HOME, 'grid.json')
  const cfg = {
    argv: ['node', DIST, '--model', MODEL, '--permission-mode', 'apollo', '--debug-file', debugFile],
    cwd: FIXTURE_CWD,
    sends,
    readyText: ['TURN-5-DONE'],
    stableTicks: 4,
    total: TOTAL,
    cols: 120,
    rows: 40,
    out,
  }
  const cfgPath = path.join(RUN_HOME, 'cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const driver = resolveCaptureDriver()
  if (driver.kind === 'unavailable') {
    console.log(`FAIL no capture driver: ${driver.reason} — ${driver.remedy}`)
    process.exit(1)
  }
  const startedAt = Date.now()
  const res = spawnSync(driver.python, [captureEngineEntry(driver, REPO), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(TOTAL * 200 + 40_000),
    cwd: FIXTURE_CWD,
    env: childEnv,
  })
  const payload = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Payload) : null
  const finalGrid = payload ? gridText(payload.grid) : ''
  const markGrid = (label: string): string => {
    const mark = payload?.marks?.find(m => m.label === label)
    return mark ? gridText(mark.grid) : ''
  }
  const receiptTick = (index: number): number => payload?.sendReceipts?.[index]?.atTick ?? -1

  section('D — the drive completed: every send fired on its await, every reply painted')
  check('vshot exited 0 with a grid', res.status === 0 && payload !== null, `status=${res.status} stderr=${(res.stderr ?? '').slice(-400)}`)
  const deadlines = sends.map(s => s.atTick)
  const fired = sends.map((_, i) => receiptTick(i))
  console.log(`  sends fired at ticks: ${fired.join(', ')} (deadlines ${deadlines.join(', ')}); ended: ${payload?.endReason ?? '?'} after ${Math.round((Date.now() - startedAt) / 1000)}s`)
  for (let i = 1; i < sends.length; i++) {
    check(`send ${i} (${sends[i]!.awaitText}) fired on its await, before its deadline`, fired[i]! > 0 && fired[i]! < deadlines[i]!, `fired at ${fired[i]} (deadline ${deadlines[i]})`)
  }
  // Replies 1–4 are proven by their sends firing on the await (each await
  // IS the reply's text); the last reply must stand on the final screen.
  check('the fifth reply painted on the final screen (TURN-5-DONE)', finalGrid.includes('TURN-5-DONE'), finalGrid.split('\n').slice(-16).join('\n'))
  check('the fold painted its boundary row', finalGrid.includes('Compacted') || markGrid('compact').includes('Compacted'))

  // ── the wire ────────────────────────────────────────────────────────────
  section('W — the wire: every consecutive pair of the conversation, the first byte that moved')
  const rows = readCapture(captureFile)
  const stream = conversationRows(rows)
  const pairs = printReport(rows)
  const lookups = stream.filter(r => (r.response?.text ?? '').startsWith(TOOL_SEARCH))
  const admissions = stream.filter(r => JSON.stringify((r.body as WireBody).messages ?? []).includes('"tool_reference"'))
  console.log(`  lookups answered: ${lookups.map(r => r.response?.text).join(' · ') || 'none'}; requests carrying an admission record: ${admissions.length}`)
  check('at least nine conversation requests (five turns, three tool rounds, the summariser)', stream.length >= 9, String(stream.length))
  check('the fixture asked for two lookups and both admitted a tool (a tool_reference record rides the later requests)', lookups.length === 2 && admissions.length >= 1, `lookups=${lookups.length} admissions=${admissions.length}`)
  check('the shell command ran (a Bash tool_result rides a later request)', stream.some(r => JSON.stringify((r.body as WireBody).messages ?? []).includes('wire-truth-echo')))

  // ── the product's own word ──────────────────────────────────────────────
  section('P — the product\'s own word beside the wire')
  const word = debugLogWord(debugFile)
  for (const line of word) console.log(`  debug: ${line.slice(0, 300)}`)
  const sessionFiles = walk(path.join(RUN_HOME, 'projects')).filter(f => f.endsWith('.jsonl'))
  const notices = sessionFiles.flatMap(transcriptNotices)
  for (const notice of notices) console.log(`  notice: ${notice.slice(0, 300)}`)
  const ledger = doctorLedgerWord(RUN_HOME)
  console.log(`  doctor ledger: ${ledger ?? 'none written'}`)

  // ── the law ─────────────────────────────────────────────────────────────
  section(REPORT ? 'T — the table (report mode asserts nothing here)' : 'L — the law: every pair holds except across the compaction')
  const unlawful = pairs.filter(p => !p.verdict.held && p.lawful === null)
  const lawful = pairs.filter(p => !p.verdict.held && p.lawful !== null)
  const held = pairs.filter(p => p.verdict.held)
  console.log(`  ${pairs.length} pairs: ${held.length} held · ${lawful.length} moved on a lawful change · ${unlawful.length} rewrote sent history`)
  for (const p of unlawful) console.log(`    rewrite: #${p.prevSeq}→#${p.curSeq} at ${p.verdict.diff?.path}`)
  if (!REPORT) {
    check('every pair outside the compaction holds (no rewrite of sent history)', unlawful.length === 0, unlawful.map(p => `#${p.prevSeq}→#${p.curSeq} ${p.verdict.diff?.path}`).join(' | '))
    check('the compaction is the only prefix move (the summariser and the post-compaction head)', lawful.length >= 1 && lawful.length <= 2 && lawful.every(p => p.lawful === 'compaction'), lawful.map(p => `#${p.prevSeq}→#${p.curSeq} ${p.lawful}`).join(' | '))
    const unlawfulDrops = stream.filter(r => (r.response?.input_transformations?.length ?? 0) > 0 && !pairs.some(p => p.curSeq === r.seq && p.lawful !== null))
    check('the API dropped no thinking outside the compaction', unlawfulDrops.length === 0, unlawfulDrops.map(r => `#${r.seq} ${r.response?.input_transformations?.[0]?.path}`).join(' | '))
    check('the operator never read the "Mercury defect" arm', !notices.some(n => n.includes('Mercury defect')) && !(ledger ?? '').includes('recurrent'), notices.join(' | ').slice(0, 300))
    const cacheZero = pairs.filter(p => p.lawful === null && p.cacheRead === 0)
    check('the prompt cache read the prefix on every held pair (cache_read > 0 outside the compaction)', cacheZero.length === 0, cacheZero.map(p => `#${p.prevSeq}→#${p.curSeq}`).join(' | '))
  }

  if (failures > 0 || REPORT) {
    console.log(`\n[forensics] capture: ${captureFile}`)
    console.log(`[forensics] replay:  node scripts/api/wire-prefix-replay.ts ${captureFile} --debug-file ${debugFile} --home ${RUN_HOME}`)
    if (failures > 0) {
      console.log(`[forensics] final screen:\n${finalGrid.split('\n').slice(-20).join('\n')}`)
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
