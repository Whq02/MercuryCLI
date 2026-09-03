#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-headless-deadlines.ts — the headless deadline
//  cluster: a headless run must NEVER hang
//  forever on a dead network; every silent wait ends in a TYPED fault and
//  the run exits with the right shape. Network fixtures, real sockets, the
//  REAL dist for every journey leg — no unit doubles.
//
//   §1 mechanism pins (pure): the stale-socket classifier recognises both
//      runtimes' wire shapes (node undici cause-chain · Bun flat code); the
//      stale-pool-reset gate is pinned LIVE in the owned table; and
//      disableKeepAlive() actually retires the memoized dispatcher —
//      RequestInit.keepalive never dropped a pooled undici socket.
//   §2 B6.4 belt — a black-holed socket (accepts, never responds): the
//      unattended-turn watchdog (MERCURY_HEADLESS_IDLE_MINUTES) aborts the
//      turn, the run writes a typed error envelope naming the knob, exit 1.
//   §3 B6.4 floor — same black hole with the belt OFF: the transport
//      budgets alone (API_TIMEOUT_MS → SDK timeout + undici headersTimeout)
//      still end the run typed. No inner bound may depend on the belt.
//   §4 SWEEP3-adjacent belt — a MID-STREAM STALL (deltas, then silence with
//      SSE heartbeats): heartbeat comment frames are not engine events, so
//      the belt fires and the run ends typed; the fixture observes the
//      abort on the wire (no follow-up request).
//   §5 mid-stream stall floor — a stall server with NO heartbeats and the
//      belt OFF: undici bodyTimeout (API_TIMEOUT_MS) kills each stalled
//      stream, the retry ladder runs dry, the run ends typed.
//   §6 B3.5 — the server-closed keep-alive replay: the fixture destroys the
//      SECOND message request arriving on a reused socket; the run recovers
//      on a fresh connection and BOTH turns succeed, in seconds.
//   §7 SWEEP3 #1 over a real socket — a streamable-HTTP tools/call that
//      never answers settles as the typed stalled-call error at the idle
//      limit AND the abandoned call is cancelled ON THE WIRE (the held
//      request's socket closes).
//   §8 B3.5 at the MCP seam — a tools/call whose socket dies under it rides
//      the reconnect-once route (stale-socket ⇒ session-expired): a second
//      initialize, the call re-sent, the result delivered.
//
//  Requires the prebuilt dist. Run:
//    ~/.bun/bin/bun run scripts/headless/prove-headless-deadlines.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — headless deadline proofs exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

// ── §1 mechanism pins (pure) ────────────────────────────────────────────────
section('§1 — stale-socket classifier · gate pin · real pool reset (pure)')
{
  const { isStaleConnectionError } = await import('../../src/services/api/withRetry.ts')
  // The SDK's connection-error class recognised BY NAME (the duplicate-copy
  // path isConnectionErrorLike honours) — the prover's local double is
  // exactly that case.
  class APIConnectionError extends Error {}

  const nodeShape = new APIConnectionError('Connection error.')
  ;(nodeShape as { cause?: unknown }).cause = new TypeError('fetch failed', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  })
  check('node shape: APIConnectionError → fetch failed → UND_ERR_SOCKET is stale', isStaleConnectionError(nodeShape))

  const bunShape = new APIConnectionError('Connection error.')
  ;(bunShape as { cause?: unknown }).cause = Object.assign(
    new Error('The socket connection was closed unexpectedly.'),
    { code: 'ECONNRESET' },
  )
  check('bun shape: flat ECONNRESET code under the connection error is stale', isStaleConnectionError(bunShape))

  const retiredAgent = new APIConnectionError('Connection error.')
  ;(retiredAgent as { cause?: unknown }).cause = Object.assign(new Error('The client is closed'), {
    code: 'UND_ERR_CLOSED',
  })
  check('a request handed to a retired agent (UND_ERR_CLOSED) is stale', isStaleConnectionError(retiredAgent))

  check(
    'a bare Error naming ECONNRESET is NOT stale (auth failures must fail the turn)',
    !isStaleConnectionError(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })),
  )
  check(
    'a connection error with no stale code is NOT stale (no rebuild storm on DNS faults)',
    !isStaleConnectionError(
      Object.assign(new APIConnectionError('Connection error.'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      }),
    ),
  )

  const { checkFeatureGate_CACHED_MAY_BE_STALE } = await import('../../src/services/analytics/featureGates.ts')
  check(
    'the stale-pool-reset gate is pinned LIVE in the owned table',
    checkFeatureGate_CACHED_MAY_BE_STALE('mercury_disable_keepalive_on_econnreset') === true,
  )

  const proxy = await import('../../src/utils/proxy.ts')
  proxy._resetKeepAliveForTesting()
  proxy._resetApiDispatcherForTesting()
  const before = proxy.getApiDispatcher()
  proxy.disableKeepAlive()
  const after = proxy.getApiDispatcher()
  check('disableKeepAlive() retires the memoized dispatcher (fresh pool identity)', before !== after)
  const opts = proxy.getProxyFetchOptions() as { keepalive?: boolean }
  check('the sticky keepalive:false hint rides subsequent fetch options', opts.keepalive === false)
  proxy._resetKeepAliveForTesting()
  proxy._resetApiDispatcherForTesting()
}

// ── shared dist-journey harness ─────────────────────────────────────────────

type Envelope = Record<string, unknown> & { type: string; subtype?: string }
type DistRun = {
  envelopes: Envelope[]
  lines: string[]
  unparseable: number
  exit: number | null
  stderr: string
  wallMs: number
}

function hermeticEnv(baseUrl: string, extra: Record<string, string>): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'hd-home-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  return {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    ...extra,
  }
}

/** Boot the REAL dist on node in stream-json/stream-json mode, send the
 *  scripted user turns (each after the previous turn's result), close stdin,
 *  and collect the whole protocol. */
async function runDistTurns(
  env: Record<string, string>,
  prompts: string[],
  opts?: { killAfterMs?: number },
): Promise<DistRun> {
  const cwd = mkdtempSync(join(tmpdir(), 'hd-cwd-'))
  const startedAt = Date.now()
  const child = spawn(
    nodeBin!,
    [DIST, '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', 'claude-opus-4-8'],
    { cwd, env },
  )
  const killer = setTimeout(() => child.kill('SIGKILL'), opts?.killAfterMs ?? 120_000)

  const lines: string[] = []
  const envelopes: Envelope[] = []
  let unparseable = 0
  let buf = ''
  let resultsSeen = 0
  let promptIndex = 0
  const sendNextPrompt = (): void => {
    if (promptIndex >= prompts.length) {
      child.stdin.end()
      return
    }
    const value = prompts[promptIndex++]!
    child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: value }, parent_tool_use_id: null }) + '\n',
    )
  }
  child.stdout.on('data', d => {
    buf += String(d)
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      lines.push(line)
      try {
        const e = JSON.parse(line) as Envelope
        envelopes.push(e)
        if (e.type === 'result') {
          resultsSeen++
          if (resultsSeen === promptIndex) sendNextPrompt()
        }
      } catch {
        unparseable++
      }
    }
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  sendNextPrompt()
  const exit = await new Promise<number | null>(res =>
    child.on('close', code => {
      clearTimeout(killer)
      res(code)
    }),
  )
  return { envelopes, lines, unparseable, exit, stderr, wallMs: Date.now() - startedAt }
}

const resultsOf = (run: DistRun): (Envelope & { result?: string; is_error?: boolean })[] =>
  run.envelopes.filter(e => e.type === 'result') as never

// ── §2 B6.4 belt: black-holed socket → typed unattended-turn end ───────────
section('§2 — black-holed socket: the belt ends the run typed (real dist)')
{
  // A TRUE black hole: accepts every connection, reads, never writes a byte.
  const sockets = new Set<Socket>()
  const blackhole: NetServer = createNetServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(r => blackhole.listen(0, '127.0.0.1', r))
  const port = (blackhole.address() as { port: number }).port

  const run = await runDistTurns(
    hermeticEnv(`http://127.0.0.1:${port}`, {
      MERCURY_HEADLESS_IDLE_MINUTES: '0.05', // 3s belt
    }),
    ['black-hole probe'],
    { killAfterMs: 90_000 },
  )
  const results = resultsOf(run)
  const errorResult = results.find(r => r.is_error === true)
  // The typed fault rides the FINAL cycle envelope's errors[] (the engine's
  // own abort envelope precedes it) — scan every result envelope.
  const text = j(results)
  check('the run ENDS (no eternal hang) with a non-zero exit', run.exit !== null && run.exit !== 0, `exit=${run.exit}`)
  check('a typed error envelope lands', errorResult !== undefined, j(run.envelopes.map(e => `${e.type}:${e.subtype ?? ''}`)))
  check('a result envelope names the unattended-turn deadline', /unattended turn: no progress/.test(text), text.slice(0, 300))
  check('a result envelope names the tuning knob', /MERCURY_HEADLESS_IDLE_MINUTES/.test(text), text.slice(0, 300))
  check('the end is prompt (belt + teardown, not a transport bleed-out)', run.wallMs < 60_000, `${run.wallMs}ms`)
  check('every stdout line is individually JSON-parseable', run.unparseable === 0, `${run.unparseable} bad of ${run.lines.length}`)
  for (const s of sockets) s.destroy()
  await new Promise<void>(r => blackhole.close(() => r()))
}

// ── §3 B6.4 floor: black hole with the belt OFF → transport budgets end it ─
section('§3 — black-holed socket, belt disabled: transport budgets alone end the run')
{
  const sockets = new Set<Socket>()
  const blackhole: NetServer = createNetServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(r => blackhole.listen(0, '127.0.0.1', r))
  const port = (blackhole.address() as { port: number }).port

  const run = await runDistTurns(
    hermeticEnv(`http://127.0.0.1:${port}`, {
      MERCURY_HEADLESS_IDLE_MINUTES: '0', // the belt is OFF — the floor must hold alone
      API_TIMEOUT_MS: '2000',
      MERCURY_MAX_RETRIES: '1',
    }),
    ['black-hole floor probe'],
    { killAfterMs: 90_000 },
  )
  const results = resultsOf(run)
  const errorResult = results.find(r => r.is_error === true)
  const text = j(errorResult ?? {})
  check('the run ENDS non-zero on transport budgets alone', run.exit !== null && run.exit !== 0, `exit=${run.exit} stderr=${run.stderr.slice(0, 200)}`)
  check('a typed error envelope lands (no silent abort)', errorResult !== undefined, j(run.envelopes.map(e => `${e.type}:${e.subtype ?? ''}`)))
  // The black-hole floor dies on the FIRST-BYTE budget since INTERRUPT-3
  // (c8e3fa5): the fault reads "no first byte from <family> after N s (…)
  // — the turn was aborted" — the budget that fired, named with its
  // seconds; the older transports still say "timed out".
  check('the fault names the timeout', /timed out|timeout|no first byte from .+ after \d+ s/i.test(text), text.slice(0, 300))
  check('the retry ladder ran dry inside the wall bound', run.wallMs < 90_000, `${run.wallMs}ms`)
  for (const s of sockets) s.destroy()
  await new Promise<void>(r => blackhole.close(() => r()))
}

// ── §4 belt over a mid-stream stall (heartbeats are not liveness) ──────────
section('§4 — mid-stream stall (hang turn): the belt fires; the abort reaches the wire')
{
  const fixture: FixtureApi = await startFixtureApi([{ kind: 'hang', deltas: ['stall-head…'] }])
  const run = await runDistTurns(
    hermeticEnv(fixture.url, {
      MERCURY_HEADLESS_IDLE_MINUTES: '0.05', // 3s belt
    }),
    ['mid-stream stall probe'],
    { killAfterMs: 90_000 },
  )
  const results = resultsOf(run)
  const errorResult = results.find(r => r.is_error === true)
  const text = j(results)
  check('the stalled turn ends typed, non-zero', run.exit !== null && run.exit !== 0 && errorResult !== undefined, `exit=${run.exit}`)
  check('a result envelope names the unattended-turn deadline + knob', /unattended turn: no progress/.test(text) && /MERCURY_HEADLESS_IDLE_MINUTES/.test(text), text.slice(0, 300))
  check('prompt end (the belt, not a 10-minute body timeout)', run.wallMs < 60_000, `${run.wallMs}ms`)
  check('exactly one model call — the aborted turn is not retried', fixture.messageRequests().length === 1, `${fixture.messageRequests().length}`)
  await fixture.close()
}

// ── §5 stall floor: no heartbeats, belt OFF → bodyTimeout ends each stream ─
section('§5 — mid-stream stall, belt disabled: undici bodyTimeout ends the run')
{
  // A stall server with NO heartbeat frames: SSE head + message_start + one
  // delta, then absolute silence — the body-inactivity clock must fire.
  let messagePosts = 0
  const stallServer: HttpServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      if (!(req.url ?? '').includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      messagePosts++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `event: message_start\ndata: ${j({ type: 'message_start', message: { id: 'msg_stall', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
      )
      res.write(
        `event: content_block_start\ndata: ${j({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      )
      res.write(
        `event: content_block_delta\ndata: ${j({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'stall…' } })}\n\n`,
      )
      // …and never another byte.
    })
  })
  await new Promise<void>(r => stallServer.listen(0, '127.0.0.1', r))
  const port = (stallServer.address() as { port: number }).port

  const run = await runDistTurns(
    hermeticEnv(`http://127.0.0.1:${port}`, {
      MERCURY_HEADLESS_IDLE_MINUTES: '0',
      API_TIMEOUT_MS: '2000', // headers AND body inactivity budget
      MERCURY_MAX_RETRIES: '1',
    }),
    ['stall floor probe'],
    { killAfterMs: 90_000 },
  )
  const results = resultsOf(run)
  const errorResult = results.find(r => r.is_error === true)
  check('the stalled-stream run ENDS non-zero with a typed envelope', run.exit !== null && run.exit !== 0 && errorResult !== undefined, `exit=${run.exit} env=${j(run.envelopes.map(e => `${e.type}:${e.subtype ?? ''}`))}`)
  check('the stall was retried then given up (≥2 attempts observed)', messagePosts >= 2, `${messagePosts} message POSTs`)
  check('the end is bounded by the small budget, not the 10-minute default', run.wallMs < 90_000, `${run.wallMs}ms`)
  stallServer.closeAllConnections?.()
  await new Promise<void>(r => stallServer.close(() => r()))
}

// ── §6 B3.5: server-closed keep-alive replay → recovery, both turns green ──
section('§6 — server-closed keep-alive replay: the run recovers on a fresh connection')
{
  const fixture: FixtureApi = await startFixtureApi(
    [
      { kind: 'text', text: 'KA-ONE.' },
      { kind: 'text', text: 'KA-TWO.' },
    ],
    { destroyOnKeepAliveReuse: true },
  )
  const run = await runDistTurns(
    hermeticEnv(fixture.url, { MERCURY_MAX_RETRIES: '2' }),
    ['keep-alive probe one', 'keep-alive probe two'],
    { killAfterMs: 90_000 },
  )
  const results = resultsOf(run)
  check('turn 1 succeeded', results.some(r => r.subtype === 'success' && r.result === 'KA-ONE.'), j(results.map(r => r.result)))
  check('turn 2 succeeded THROUGH the replay (recovery, not luck)', results.some(r => r.result === 'KA-TWO.'), j(results.map(r => r.result)))
  check('the fixture really destroyed a replayed request', fixture.destroyedReplays() >= 1, `${fixture.destroyedReplays()} replays destroyed`)
  check('recovery was immediate (no headers-timeout bleed-out)', run.wallMs < 45_000, `${run.wallMs}ms`)
  check('the run exits clean after recovery', run.exit === 0, `exit=${run.exit} stderr=${run.stderr.slice(0, 200)}`)
  await fixture.close()
}

// ── minimal streamable-HTTP MCP fixture (real sockets) ─────────────────────

type McpFixture = {
  url: string
  initializeCount(): number
  toolCallCount(): number
  cancelledCount(): number
  heldCallSocketClosed(): boolean
  close(): Promise<void>
}

/** killNthToolCall: destroy that call's socket AFTER the body is read (the
 *  connection dies under the in-flight call). stallCalls: never answer any
 *  tools/call — hold the request open and record when the CLIENT tears the
 *  socket down (the on-wire cancel observation). */
async function startMcpFixture(behavior: { stallCalls?: boolean; killNthToolCall?: number }): Promise<McpFixture> {
  let initializes = 0
  let toolCalls = 0
  let cancels = 0
  let heldClosed = false
  const server: HttpServer = createHttpServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      let body: { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string } } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as never
      } catch {
        // fall through — answered as an empty 202 below
      }
      const answer = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'hd-fixture-session' })
        res.end(j({ jsonrpc: '2.0', id: body.id, result }))
      }
      if (body.method === 'initialize') {
        initializes++
        answer({
          protocolVersion: body.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'hd-fixture', version: '1.0.0' },
        })
        return
      }
      if (body.method === 'tools/list') {
        answer({ tools: [{ name: 'probe', description: 'answers', inputSchema: { type: 'object' } }] })
        return
      }
      if (body.method === 'tools/call') {
        toolCalls++
        if (behavior.killNthToolCall === toolCalls) {
          req.socket.destroy()
          return
        }
        if (behavior.stallCalls) {
          req.socket.on('close', () => {
            heldClosed = true
          })
          return // hold forever; the client's cancel is the observation
        }
        answer({ content: [{ type: 'text', text: `pong-${toolCalls}` }] })
        return
      }
      // notifications (initialized, cancelled) and anything else: accepted.
      if (body.method === 'notifications/cancelled') cancels++
      res.writeHead(202).end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    initializeCount: () => initializes,
    toolCallCount: () => toolCalls,
    cancelledCount: () => cancels,
    heldCallSocketClosed: () => heldClosed,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(r => server.close(() => r()))
    },
  }
}

// Hermetic home for the MCP legs (the real connect path reads config homes).
const MCP_SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'hd-mcp-'))
process.env.MERCURY_CONFIG_DIR = join(MCP_SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

// ── §7 SWEEP3 #1: stalled tools/call over a real socket → typed + cancelled ─
section('§7 — MCP stalled tools/call (real streamable HTTP): typed stall + on-wire cancel')
{
  process.env.MERCURY_MCP_CALL_IDLE_MINUTES = '0.003' // 180ms
  const fixture = await startMcpFixture({ stallCalls: true })
  const { callMCPToolWithUrlElicitationRetry } = await import('../../src/services/mcp/client.ts')
  const connection = {
    name: 'hd7',
    type: 'failed',
    config: { type: 'http', url: fixture.url, scope: 'dynamic' },
    error: 'prover seed',
  }
  const parent = { message: { content: [{ type: 'tool_use', id: 'tu-hd7', name: 'probe', input: {} }] } }
  const startedAt = Date.now()
  let stallError: unknown = null
  try {
    await callMCPToolWithUrlElicitationRetry({
      client: connection as never,
      tool: 'probe',
      args: {},
      signal: new AbortController().signal,
      parentMessage: parent as never,
    })
  } catch (error) {
    stallError = error
  }
  const settleMs = Date.now() - startedAt
  const message = stallError instanceof Error ? stallError.message : String(stallError)
  check('the stalled call settles as the TYPED stalled error', /stalled: no result and no progress/.test(message), message.slice(0, 220))
  check('the error names the tuning knob', /MERCURY_MCP_CALL_IDLE_MINUTES/.test(message))
  check('it settles at the idle limit, not a 60s fetch budget', settleMs < 10_000, `${settleMs}ms`)
  // Streamable HTTP abandons a call as a notifications/cancelled POST (the
  // held response socket itself stays parked until transport close).
  const cancelled = await (async () => {
    for (let waited = 0; waited < 5_000; waited += 100) {
      if (fixture.cancelledCount() > 0 || fixture.heldCallSocketClosed()) return true
      await new Promise(r => setTimeout(r, 100))
    }
    return fixture.cancelledCount() > 0 || fixture.heldCallSocketClosed()
  })()
  check('the abandoned call is cancelled ON THE WIRE (cancelled notification or socket teardown)', cancelled, `cancels=${fixture.cancelledCount()} socketClosed=${fixture.heldCallSocketClosed()}`)
  await fixture.close()
}

// ── §8 B3.5 at the MCP seam: dead socket under a call → reconnect-once ─────
section('§8 — MCP dead-socket call: stale-socket rides the reconnect-once route')
{
  process.env.MERCURY_MCP_CALL_IDLE_MINUTES = '0.5' // 30s — not the actor here
  const fixture = await startMcpFixture({ killNthToolCall: 2 })
  const { callMCPToolWithUrlElicitationRetry, clearServerCache } = await import('../../src/services/mcp/client.ts')
  const connection = {
    name: 'hd8',
    type: 'failed',
    config: { type: 'http', url: fixture.url, scope: 'dynamic' },
    error: 'prover seed',
  }
  // A fresh cache row for this name+config (the §7 leg used its own name).
  await clearServerCache('hd8', connection.config as never).catch(() => {})
  const call = (id: string) =>
    callMCPToolWithUrlElicitationRetry({
      client: connection as never,
      tool: 'probe',
      args: {},
      signal: new AbortController().signal,
      parentMessage: { message: { content: [{ type: 'tool_use', id, name: 'probe', input: {} }] } } as never,
    })

  const first = await call('tu-hd8-1')
  check('call 1 answers normally', j(first.content).includes('pong-1'), j(first.content).slice(0, 120))

  const startedAt = Date.now()
  const second = await call('tu-hd8-2')
  const wallMs = Date.now() - startedAt
  check(
    'the killed call recovers THROUGH the reconnect-once route (a re-sent call answered)',
    j(second.content).includes('pong-3'),
    j(second.content).slice(0, 160),
  )
  check(
    // Streamable HTTP recovers a dead socket WITHOUT a fresh initialize —
    // the mcp-session-id survives the connection by the transport's own
    // design, so the reconnect-once fact ON THE WIRE is the re-sent call:
    // call 2 died mid-socket, call 3 answered. (The old pin demanded a
    // second initialize — the stdio-shaped expectation this HTTP seam
    // never owed.)
    'the route re-sent the call on a fresh connection (call 2 died, call 3 served)',
    fixture.toolCallCount() >= 3,
    `${fixture.toolCallCount()} tools/call POSTs · ${fixture.initializeCount()} initializes`,
  )
  check('recovery is immediate', wallMs < 10_000, `${wallMs}ms`)
  await fixture.close()
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ HEADLESS DEADLINES GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} HEADLESS DEADLINE FAILURE(S)`)
process.exit(1)
