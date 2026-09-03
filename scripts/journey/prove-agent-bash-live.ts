#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-agent-bash-live.ts — a sub-agent's SHELL on the REAL
//  product. The shipped dist boots in a PTY (vshot) on a hermetic seeded
//  home, a content-routed fixture plays the model on BOTH wire dialects, the
//  operator's typed ask launches a general-purpose sub-agent whose task
//  needs the shell, and the marked frames plus the fixture's captured
//  request bodies are the verdict.
//
//  The sub-agent runs TWO shell commands: a read-only one (`git rev-parse
//  --short HEAD` — the read-only lane allows it in every mode: no ask, no
//  classifier) and a WRITING one (an empty commit, then the new sha — the ask
//  road: the consent card in default mode, the flow classifier in flow; a
//  redirect would not do, since implement mode's fast path allows a write
//  inside the cwd before any classifier). The seat's final text quotes the
//  sha the shell printed and the parent's final text quotes the seat's
//  report; both are read off the wire (the FIFO law: a tool_use rides a
//  request body only together with its result) and off the frame.
//
//  Legs (AB_LEG=<leg> runs one; unset runs every leg in turn):
//    default-fg      default mode · foreground agent · the card answers the ask
//    default-bg      default mode · BACKGROUND agent · the card still answers:
//                    the agent's ask parks on the session's ask table, the
//                    focused chat paints it, the operator's ↵ runs the shell
//    flow-fg         flow mode · foreground · the classifier is reached ONCE
//                    (the writing command) and never for the read-only one;
//                    no card
//    openai-fg       default mode · foreground · the session and the seat ride
//                    the Responses dialect (the road is family-blind)
//    headless-stdio  no PTY: `-p --input-format stream-json` with the stdio
//                    prompt tool — the transport every daemon seat speaks. A
//                    BACKGROUND agent's ask arrives as a can_use_tool control
//                    request carrying agent_id; the host allows; the shell runs
//    headless-plain  no PTY, no prompt tool: the read-only command runs, the
//                    writing one is auto-denied with the headless note — the
//                    posture the main thread has in a prompt-less run
//
//  Ports 25171–25176. The fixture lives in THIS process, so the capture
//  engine is spawned async. AB_KEEP=1 prints every marked frame and keeps the
//  homes.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const KEEP = process.env.AB_KEEP === '1'

/** The operator's ask and the seat's brief — the routing markers. */
const ASK = 'agent-bash: launch the shell probe'
const FOLLOW_UP = 'agent-bash: what did the agent report?'
const SEAT_BRIEF = 'agent-bash-seat: run the shell probe in the working directory and report the sha'
const READ_ONLY_COMMAND = 'git rev-parse --short HEAD'
const PROBE_COMMIT = 'agent-bash-probe'
const WRITING_COMMAND = `git commit --allow-empty -q -m ${PROBE_COMMIT} && git rev-parse --short HEAD`
const CARD_WORDS = 'Do you want to proceed?'
const GPT_MODEL = 'gpt-5.6-sol'
/** The fixture server's canonical proof key — the seeder approves it. */
const FIXTURE_API_KEY = 'fixture-key-000'

// ── the content-routed fixture (both dialects) ──────────────────────────────
type Dialect = 'anthropic' | 'openai'
type Route = 'classifier' | 'parent' | 'parent-ack' | 'seat-1' | 'seat-2' | 'seat-done' | 'side'
interface Hit {
  n: number
  route: Route
  dialect: Dialect
  streaming: boolean
  model: string
  tools: string[]
  results: string[]
  body: unknown
}
interface Fixture {
  base: string
  hits: Hit[]
  close(): Promise<void>
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** The text of a content value: a string, or the text-bearing blocks of an array. */
function textOf(content: unknown, blockType: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: string; text?: string }
      return b?.type === blockType && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/** The tools a request offers, by name, on either dialect. */
function toolNamesOf(body: unknown): string[] {
  const tools = (body as { tools?: unknown[] })?.tools
  if (!Array.isArray(tools)) return []
  return tools
    .map(t => {
      const tool = t as { name?: string; function?: { name?: string } }
      return typeof tool?.name === 'string' ? tool.name : typeof tool?.function?.name === 'string' ? tool.function.name : ''
    })
    .filter(name => name !== '')
}

/** Every top-level user TEXT in order (a tool result never counts). */
function userTextsOf(body: unknown, dialect: Dialect): string[] {
  const out: string[] = []
  if (dialect === 'anthropic') {
    for (const m of (body as { messages?: unknown[] })?.messages ?? []) {
      const msg = m as { role?: string; content?: unknown }
      if (msg.role !== 'user') continue
      const text = textOf(msg.content, 'text')
      if (text.trim() !== '') out.push(text)
    }
    return out
  }
  for (const item of (body as { input?: unknown[] })?.input ?? []) {
    const row = item as { type?: string; role?: string; content?: unknown }
    if (row.type !== 'message' || row.role !== 'user') continue
    const text = textOf(row.content, 'input_text')
    if (text.trim() !== '') out.push(text)
  }
  return out
}

/** Every tool result's text in order — the FIFO law's evidence. */
function resultTextsOf(body: unknown, dialect: Dialect): string[] {
  const out: string[] = []
  if (dialect === 'anthropic') {
    for (const m of (body as { messages?: unknown[] })?.messages ?? []) {
      const msg = m as { role?: string; content?: unknown }
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const block of msg.content as Array<{ type?: string; content?: unknown }>) {
        if (block.type === 'tool_result') out.push(textOf(block.content, 'text'))
      }
    }
    return out
  }
  for (const item of (body as { input?: unknown[] })?.input ?? []) {
    const row = item as { type?: string; output?: unknown }
    if (row.type !== 'function_call_output') continue
    out.push(typeof row.output === 'string' ? row.output : textOf(row.output, 'input_text'))
  }
  return out
}

/** The parent is the request that CARRIES the Agent tool (a seat never has
 *  it); a seat is the request whose brief names the seat; the classifier is
 *  the request that offers its own verdict tool; anything else is a side
 *  call (a title or summary ask) and answers "ok". */
function routeOf(body: unknown, dialect: Dialect): { route: Route; tools: string[]; results: string[] } {
  const tools = toolNamesOf(body)
  const results = resultTextsOf(body, dialect)
  if (tools.includes('classify_result')) return { route: 'classifier', tools, results }
  if (tools.includes('Agent')) return { route: results.length === 0 ? 'parent' : 'parent-ack', tools, results }
  if (userTextsOf(body, dialect).some(text => text.includes('agent-bash-seat:'))) {
    const route: Route = results.length === 0 ? 'seat-1' : results.length === 1 ? 'seat-2' : 'seat-done'
    return { route, tools, results }
  }
  return { route: 'side', tools, results }
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

/** One /v1/messages answer as a plain JSON message — the wire's own shape
 *  for a request without `stream: true` (the flow classifier's side query
 *  asks that way; an SSE body there reads as an answer with no blocks and
 *  the classifier blocks "for safety"). */
function anthropicJsonAnswer(n: number, model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const content = blocks.map((block, index) =>
    block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool_use', id: `toolu_ab_${n}_${index}`, name: block.name, input: block.input },
  )
  return JSON.stringify({
    id: `msg_ab_${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output },
  })
}

/** One /v1/messages SSE answer — the requested model echoed, usage stated. */
function anthropicAnswer(n: number, model: string, blocks: Block[], usage: { input: number; output: number }): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_ab_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    } else {
      parts.push(
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_ab_${n}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

/** One Responses SSE answer — function_call items or the final text. */
function responsesAnswer(n: number, blocks: Block[], usage: { input: number; output: number }): string {
  const rid = `resp_ab_${n}`
  const parts: string[] = [sse({ type: 'response.created', response: { id: rid } })]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      parts.push(
        sse({ type: 'response.output_text.delta', delta: block.text }),
        sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] } }),
      )
    } else {
      parts.push(
        sse({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call_ab_${n}_${index}`, name: block.name, arguments: JSON.stringify(block.input) } }),
      )
    }
  })
  parts.push(sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: usage.input, output_tokens: usage.output, input_tokens_details: { cached_tokens: 0 } } } }))
  return parts.join('')
}

/** The shell's own first line of a Bash result — the executor may append a
 *  system reminder (the deferred-tools delta) after the command's output. */
const firstLine = (text: string | undefined): string => (text ?? '').trim().split('\n')[0]?.trim() ?? ''

/** The seat's report: the sha the last shell result printed, or the plain
 *  fact that it is not a sha (a refusal quoted for the frame). */
function seatReport(results: string[]): string {
  const last = firstLine(results[results.length - 1])
  return /^[0-9a-f]{7,12}$/.test(last) ? `agent-bash-seat-done: sha=${last}` : `agent-bash-seat-done: not-a-sha (${(results[results.length - 1] ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)})`
}

/** The parent's report: the seat's report wherever the request carries it —
 *  an Agent tool result (foreground) or the completion notice a later turn
 *  delivers (background). */
function parentReport(body: unknown): string {
  const serialized = JSON.stringify(body)
  const matches = [...serialized.matchAll(/agent-bash-seat-done: (sha=[0-9a-f]+|not-a-sha)/g)]
  const last = matches[matches.length - 1]
  if (!last) return 'agent-bash: launched; the report arrives with the next turn'
  return `agent-bash: reported ${last[1]}`
}

async function startFixture(port: number, opts: { background: boolean }): Promise<Fixture> {
  const hits: Hit[] = []
  const gptModel = {
    id: GPT_MODEL,
    slug: GPT_MODEL,
    display_name: 'GPT-5.6 Sol',
    supported_reasoning_levels: ['low', 'medium', 'high'],
    default_reasoning_level: 'medium',
    visibility: 'public',
    supported_in_api: true,
    priority: 1,
    context_window: 400_000,
    input_modalities: ['text', 'image'],
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      // The OpenAI account's discovery only; every other probe (the
      // Anthropic reachability probe included) answers the empty object.
      if (req.method === 'GET' && url.includes('/openai/') && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [gptModel], models: [gptModel] }))
        return
      }
      const dialect: Dialect | null = url.endsWith('/v1/messages') ? 'anthropic' : url.endsWith('/responses') ? 'openai' : null
      if (req.method !== 'POST' || dialect === null) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let body: unknown = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
      const { route, tools, results } = routeOf(body, dialect)
      const n = hits.length + 1
      hits.push({ n, route, dialect, streaming: (body as { stream?: unknown })?.stream === true, model, tools, results, body })
      let blocks: Block[]
      let usage = { input: 40, output: 8 }
      switch (route) {
        case 'classifier':
          blocks = [{ type: 'tool_use', name: 'classify_result', input: { thinking: 'The action writes one file inside the working directory.', shouldBlock: false, reason: 'agent-bash: allowed by the fixture classifier' } }]
          break
        case 'parent':
          blocks = [
            { type: 'text', text: 'agent-bash: launching the shell probe' },
            { type: 'tool_use', name: 'Agent', input: { description: 'agent-bash-seat', prompt: SEAT_BRIEF, subagent_type: 'general-purpose', ...(opts.background ? { run_in_background: true } : {}) } },
          ]
          usage = { input: 1200, output: 60 }
          break
        case 'parent-ack':
          blocks = [{ type: 'text', text: parentReport(body) }]
          usage = { input: 1500, output: 30 }
          break
        case 'seat-1':
          blocks = [{ type: 'tool_use', name: 'Bash', input: { command: READ_ONLY_COMMAND, description: 'the short sha' } }]
          usage = { input: 900, output: 40 }
          break
        case 'seat-2':
          blocks = [{ type: 'tool_use', name: 'Bash', input: { command: WRITING_COMMAND, description: 'the probe commit and its sha' } }]
          usage = { input: 950, output: 40 }
          break
        case 'seat-done':
          blocks = [{ type: 'text', text: seatReport(results) }]
          usage = { input: 1000, output: 30 }
          break
        default:
          blocks = [{ type: 'text', text: 'ok' }]
          usage = { input: 20, output: 2 }
      }
      const streaming = (body as { stream?: unknown })?.stream === true
      if (dialect === 'anthropic' && !streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(anthropicJsonAnswer(n, model, blocks, usage))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(dialect === 'anthropic' ? anthropicAnswer(n, model, blocks, usage) : responsesAnswer(n, blocks, usage))
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

// ── the hermetic world ──────────────────────────────────────────────────────
interface World {
  home: string
  cwd: string
  sha: string
}

/** A seeded home (the one seeder — onboarding, trust for the cwd, the
 *  fixture key approved; the flow notice AND the "make flow your default"
 *  nudge already seen: a saved non-flow default mode raises that nudge's
 *  select over the composer at birth, and a prompt typed into it picks
 *  "Yes" — live-found) and a working directory that IS a git repository
 *  with one commit, so the probe has a sha to print. */
function seedWorld(settings: Record<string, unknown>): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-bash-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agent-bash-cwd-')))
  const git = (args: string[]): string => {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout.trim()
  }
  git(['init', '-q'])
  // The identity the agent's own commit needs, repo-local (hermetic).
  git(['config', 'user.name', 'probe'])
  git(['config', 'user.email', 'probe@example.invalid'])
  writeFileSync(join(cwd, 'README.md'), 'the shell probe repository\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'the probe commit'])
  const sha = git(['rev-parse', '--short', 'HEAD'])
  seedFirstRun(home, [cwd])
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, hasSeenAutoDefaultNotice: true, hasSeenAutoDefaultNudge: true }, null, 2) + '\n')
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')
  return { home, cwd, sha }
}

function driveEnv(home: string, fixtureBase: string, openai = false): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    // The OpenAI account exists only on the Responses leg; every other leg
    // boots with the Anthropic lane alone.
    ...(openai ? { OPENAI_API_KEY: 'fixture-openai-key', MERCURY_OPENAI_API_BASE: `${fixtureBase}/openai/v1` } : { OPENAI_API_KEY: '' }),
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
}

function keepOrDrop(world: World, label: string): void {
  if (KEEP) {
    console.log(`[keep] ${label} home ${world.home} cwd ${world.cwd}`)
    return
  }
  rmSync(world.home, { recursive: true, force: true })
  rmSync(world.cwd, { recursive: true, force: true })
}

/** A refusal in a tool result — the words every denial road spells. */
const DENIAL_WORDS = ['has been denied', 'auto-denied', 'was denied', "doesn't want to proceed", 'tool_use_error', 'was rejected', 'blocked this action']
const isDenial = (text: string): boolean => DENIAL_WORDS.some(word => text.includes(word))

function evidence(fixture: Fixture, world: World): void {
  console.log(`  evidence · sha ${world.sha} · hits: ${fixture.hits.map(h => `${h.n}:${h.route}/${h.dialect}${h.streaming ? '' : '/json'}/${h.model}${h.tools.length ? `[${h.tools.includes('Bash') ? 'Bash' : 'no-Bash'}${h.tools.includes('Agent') ? '+Agent' : ''}]` : ''}`).join(' ')}`)
  for (const hit of fixture.hits) {
    if (hit.results.length === 0) continue
    console.log(`  evidence · request ${hit.n} (${hit.route}) results: ${hit.results.map(r => JSON.stringify(r.replace(/\s+/g, ' ').slice(0, 140))).join(' · ')}`)
  }
}

/** The repository's sha after a run (the probe commit moves it). */
function headSha(cwd: string): string {
  return spawnSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}
function commitCount(cwd: string): string {
  return spawnSync('git', ['-C', cwd, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}

/** The wire checks every leg shares: the seat offers Bash, the read-only
 *  command ran without an ask, the writing command ran (the probe commit
 *  landed and its sha came back), the reports rode the wire. */
function checkWire(label: string, fixture: Fixture, world: World): void {
  const seat1 = fixture.hits.find(h => h.route === 'seat-1')
  const seat2 = fixture.hits.find(h => h.route === 'seat-2')
  const seatDone = fixture.hits.find(h => h.route === 'seat-done')
  const parentAcks = fixture.hits.filter(h => h.route === 'parent-ack')
  const parentAck = parentAcks[parentAcks.length - 1]
  check(`${label}: the seat's request offers Bash and never the Agent tool`, seat1 !== undefined && seat1.tools.includes('Bash') && !seat1.tools.includes('Agent'), seat1 ? seat1.tools.join(',') : 'no seat request')
  check(`${label}: the read-only command ran with no ask — its result is the sha`, seat2 !== undefined && firstLine(seat2.results[0]) === world.sha, seat2 ? JSON.stringify(seat2.results[0]) : 'no second seat request')
  const after = headSha(world.cwd)
  check(`${label}: the writing command ran — the probe commit landed and its sha came back, no refusal`, seatDone !== undefined && after !== world.sha && commitCount(world.cwd) === '2' && firstLine(seatDone.results[1]) === after && !isDenial(seatDone.results[1] ?? ''), seatDone ? `${JSON.stringify(seatDone.results[1])} · head ${after} · commits ${commitCount(world.cwd)}` : 'no seat-done request')
  check(`${label}: the parent's request carried the seat's report`, parentAck !== undefined && JSON.stringify(parentAck.body).includes(`agent-bash-seat-done: sha=${after}`), parentAck ? JSON.stringify(parentAck.results.map(r => r.slice(0, 120))) : 'no parent-ack')
}

// ── the PTY capture (vshot, async — the fixture lives in this process) ──────
interface Capture {
  text: string
  marks: Record<string, string>
  sends: number
  receipts: number
  endReason: string
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string =>
  grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')

async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bash-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; grid: Grid }>
    endReason?: string
  }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return {
    text: gridText(payload.grid),
    marks,
    sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
    endReason: payload.endReason ?? '',
  }
}

const COLS = 160
const ROWS = 44

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  // The landing rule: a bare boot lands on the Boot face — ↵ on New Session
  // births the session and enters it (an observed-ready send, never blind;
  // the face's ↵ waits for the paint to settle and hold).
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  // The status row's "· ready" is the chat's own ready word: the seat is
  // claimed and the composer is input-wired. The placeholder alone paints
  // earlier, while the seat is still starting, and a prompt typed into that
  // window is eaten (live-found: "no prompts sent yet" with an empty
  // composer and no request on the wire).
  { data: ask, atTick: 999, awaitText: '· ready', requireAwait: true, minTick: 5, awaitSettleTicks: 4, mark: 'typed' },
  { data: '\r', afterPrevTicks: 4, mark: 'sent' },
]
/** The consent card's ↵ — "Yes" is the first row. */
const cardSend = (mark: string): Record<string, unknown> => ({ data: '\r', atTick: 999, awaitText: CARD_WORDS, requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark })

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row.slice(0, COLS)}`)
}

function dumpFrames(label: string, cap: Capture, failedHere: boolean): void {
  if (!failedHere && !KEEP) return
  for (const [mark, frame] of Object.entries(cap.marks)) dump(`${label} · ${mark}`, frame)
  dump(`${label} · final grid`, cap.text)
}

// ── the PTY legs ────────────────────────────────────────────────────────────
interface PtyLeg {
  name: string
  port: number
  background: boolean
  settings: Record<string, unknown>
  argv: string[]
  /** The sends after the boot + ask. */
  sends: Array<Record<string, unknown>>
  total: number
}

const PTY_LEGS: Record<string, PtyLeg> = {
  'default-fg': {
    name: 'default-fg',
    port: 25171,
    background: false,
    settings: { permissions: { defaultMode: 'default' } },
    argv: [],
    sends: [cardSend('card')],
    total: 450,
  },
  'default-bg': {
    name: 'default-bg',
    port: 25172,
    background: true,
    settings: { permissions: { defaultMode: 'default' } },
    argv: [],
    sends: [
      cardSend('card'),
      // The Crew view is the live landing signal for a background agent:
      // its header counts the running seats.
      { data: '/teammates', afterPrevTicks: 6 },
      { data: '\r', afterPrevTicks: 4 },
      { data: '\x1b', atTick: 999, awaitText: '0 running · 1 sub-agent', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'crew-landed' },
      // The report is delivered with the next turn.
      { data: FOLLOW_UP, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
      { data: '\r', afterPrevTicks: 4 },
    ],
    total: 550,
  },
  'flow-fg': {
    name: 'flow-fg',
    port: 25173,
    background: false,
    // The session's own posture is carried to the seat at its birth: the
    // explicit flag is the flow drive's way (a saved default alone left the
    // seat in the boot's default mode — live-found).
    settings: {},
    argv: ['--permission-mode', 'flow'],
    sends: [],
    total: 450,
  },
  'openai-fg': {
    name: 'openai-fg',
    port: 25174,
    background: false,
    settings: { permissions: { defaultMode: 'default' } },
    argv: ['--model', GPT_MODEL],
    sends: [cardSend('card')],
    total: 450,
  },
}

async function runPtyLeg(leg: PtyLeg): Promise<void> {
  console.log(`\n— leg ${leg.name} —`)
  const before = failures
  const fixture = await startFixture(Number(process.env[`AB_PORT_${leg.name.replace('-', '_').toUpperCase()}`] ?? String(leg.port)), { background: leg.background })
  const world = seedWorld(leg.settings)
  let cap: Capture | null = null
  try {
    cap = await capture(
      {
        cols: COLS,
        rows: ROWS,
        total: leg.total,
        cwd: world.cwd,
        argv: ['node', DIST, ...leg.argv],
        sends: [...bootSends(ASK), ...leg.sends],
        // The sha the seat reports is the probe commit's — unknown before
        // the run, so the ready word is the report's prefix.
        readyText: ['agent-bash: reported sha='],
        stableTicks: 6,
      },
      driveEnv(world.home, fixture.base, leg.name === 'openai-fg'),
    )
  } finally {
    await fixture.close()
  }
  evidence(fixture, world)
  check(`${leg.name}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  checkWire(leg.name, fixture, world)
  check(`${leg.name}: the parent's final text painted with the probe commit's sha`, cap.text.includes(`agent-bash: reported sha=${headSha(world.cwd)}`))
  const classifierHits = fixture.hits.filter(h => h.route === 'classifier')
  if (leg.name === 'flow-fg') {
    check('flow-fg: the classifier was reached exactly once — for the writing command, never the read-only one', classifierHits.length === 1 && JSON.stringify(classifierHits[0]?.body).includes(PROBE_COMMIT), `${classifierHits.length} classifier call(s)`)
    check('flow-fg: no consent card (the classifier answered)', !cap.text.includes(CARD_WORDS) && !Object.values(cap.marks).some(f => f.includes(CARD_WORDS)))
  } else {
    check(`${leg.name}: the classifier was never called (not a flow session)`, classifierHits.length === 0, `${classifierHits.length} classifier call(s)`)
    const card = cap.marks['card'] ?? ''
    check(`${leg.name}: the consent card painted for the agent's writing command`, card.includes(CARD_WORDS) && card.includes('git commit --allow-empty'))
  }
  if (leg.name === 'default-bg') {
    const landed = cap.marks['crew-landed'] ?? ''
    check('default-bg: the Crew view read the background agent landed', landed.includes('0 running · 1 sub-agent'))
  }
  if (leg.name === 'openai-fg') {
    const seat = fixture.hits.find(h => h.route === 'seat-1')
    check('openai-fg: the seat rode the Responses dialect on the session model', seat?.dialect === 'openai' && seat.model === GPT_MODEL, seat ? `${seat.dialect}/${seat.model}` : 'no seat')
    const parent = fixture.hits.find(h => h.route === 'parent')
    check('openai-fg: the parent rode the Responses dialect too', parent?.dialect === 'openai')
  }
  dumpFrames(`leg ${leg.name}`, cap, failures > before)
  keepOrDrop(world, leg.name)
}

// ── the headless legs (node spawn, no PTY) ──────────────────────────────────
interface HeadlessRun {
  frames: Array<Record<string, unknown>>
  controlRequests: Array<Record<string, unknown>>
  stderr: string
  exit: number | null
}

const nodeBin = findOnPath('node', process.env, process.platform)

function headlessEnv(world: World, fixtureBase: string): NodeJS.ProcessEnv {
  return {
    HOME: world.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    ...driveEnv(world.home, fixtureBase, false),
    // The fixture host is not first-party: the explicit value puts the field
    // and the header on this wire.
    MERCURY_THINKING_BINDING: 'drop_block',
  }
}

/** One stream-json process: the prompts go in as user frames, every stdout
 *  frame is recorded, and a can_use_tool control request is answered ALLOW
 *  at once (the host of a daemon seat is the operator's card; here the host
 *  is this prover). `turns` are written one per result envelope; a turn may
 *  wait for a fixture route before it is written. */
function runStreamJson(world: World, fixture: Fixture, args: string[], turns: Array<{ prompt: string; waitFor?: () => boolean }>): Promise<HeadlessRun> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: world.cwd, env: headlessEnv(world, fixture.base) })
    const frames: Array<Record<string, unknown>> = []
    const controlRequests: Array<Record<string, unknown>> = []
    let stdout = ''
    let stderr = ''
    let consumed = 0
    let sent = 0
    let results = 0
    let ended = false
    const finish = (exit: number | null): void => {
      if (ended) return
      ended = true
      clearTimeout(killer)
      clearInterval(pump)
      resolvePromise({ frames, controlRequests, stderr, exit })
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const sendNext = (): void => {
      if (sent >= turns.length) {
        child.stdin.end()
        return
      }
      const turn = turns[sent]!
      if (turn.waitFor && !turn.waitFor()) return
      sent++
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: turn.prompt } }) + '\n')
    }
    const pump = setInterval(sendNext, 200)
    child.stdout.on('data', d => {
      stdout += String(d)
      const lines = stdout.split('\n')
      for (; consumed < lines.length - 1; consumed++) {
        const line = lines[consumed]!.trim()
        if (line === '') continue
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        frames.push(frame)
        if (frame.type === 'control_request') {
          const request = (frame.request ?? {}) as Record<string, unknown>
          if (request.subtype === 'can_use_tool') {
            controlRequests.push(frame)
            child.stdin.write(
              JSON.stringify({
                type: 'control_response',
                response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: request.input } },
              }) + '\n',
            )
          }
        }
        if (frame.type === 'result') {
          results++
          if (sent >= turns.length) child.stdin.end()
        }
      }
    })
    child.stderr.on('data', d => (stderr += String(d)))
    child.on('close', exit => finish(exit))
    child.on('error', () => finish(null))
    sendNext()
  })
}

const resultTexts = (run: HeadlessRun): string[] => run.frames.filter(f => f.type === 'result').map(f => String((f as { result?: unknown }).result ?? ''))

async function runHeadlessStdio(): Promise<void> {
  console.log('\n— leg headless-stdio (background agent · the stdio prompt tool) —')
  const before = failures
  const fixture = await startFixture(Number(process.env.AB_PORT_HEADLESS_STDIO ?? '25175'), { background: true })
  const world = seedWorld({ permissions: { defaultMode: 'default' } })
  let run: HeadlessRun
  try {
    run = await runStreamJson(
      world,
      fixture,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--model', 'claude-opus-5'],
      [
        { prompt: ASK },
        // The follow-up waits for the background agent's report to exist on
        // the wire — the delivery rides the next turn.
        { prompt: FOLLOW_UP, waitFor: () => fixture.hits.some(h => h.route === 'seat-done') },
      ],
    )
  } finally {
    await fixture.close()
  }
  evidence(fixture, world)
  const asks = run.controlRequests.map(f => (f.request ?? {}) as Record<string, unknown>)
  console.log(`  evidence · control requests: ${asks.map(a => `${String(a.tool_name)}${a.agent_id ? ` agent_id=${String(a.agent_id).slice(0, 18)}…` : ' (no agent_id)'} ${JSON.stringify((a.input as { command?: string })?.command ?? '')}`).join(' · ') || 'none'}`)
  checkWire('headless-stdio', fixture, world)
  check("headless-stdio: the background agent's writing command asked through the stdio channel — one can_use_tool request, Bash, carrying the agent's id", asks.length === 1 && asks[0]?.tool_name === 'Bash' && typeof asks[0]?.agent_id === 'string' && String((asks[0]?.input as { command?: string })?.command).includes(PROBE_COMMIT), `${asks.length} request(s)`)
  const texts = resultTexts(run)
  check('headless-stdio: two turns settled and the second reported the probe commit\'s sha', texts.length === 2 && texts[1]!.includes(`agent-bash: reported sha=${headSha(world.cwd)}`), JSON.stringify(texts))
  if (failures > before || KEEP) console.log(`  stderr tail: ${run.stderr.slice(-600)}`)
  keepOrDrop(world, 'headless-stdio')
}

async function runHeadlessPlain(): Promise<void> {
  console.log('\n— leg headless-plain (foreground agent · no prompt tool) —')
  const before = failures
  const fixture = await startFixture(Number(process.env.AB_PORT_HEADLESS_PLAIN ?? '25176'), { background: false })
  const world = seedWorld({ permissions: { defaultMode: 'default' } })
  let run: HeadlessRun
  try {
    run = await runStreamJson(world, fixture, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5'], [{ prompt: ASK }])
  } finally {
    await fixture.close()
  }
  evidence(fixture, world)
  const seat1 = fixture.hits.find(h => h.route === 'seat-1')
  const seat2 = fixture.hits.find(h => h.route === 'seat-2')
  const seatDone = fixture.hits.find(h => h.route === 'seat-done')
  check("headless-plain: the seat's request offers Bash", seat1 !== undefined && seat1.tools.includes('Bash'))
  check('headless-plain: the read-only command ran — its result is the sha', seat2 !== undefined && firstLine(seat2.results[0]) === world.sha, seat2 ? JSON.stringify(seat2.results[0]) : 'no second seat request')
  check('headless-plain: the writing command was auto-denied with the headless note (the prompt-less posture, the same as the main thread)', seatDone !== undefined && (seatDone.results[1] ?? '').includes('auto-denied'), seatDone ? JSON.stringify((seatDone.results[1] ?? '').slice(0, 200)) : 'no seat-done request')
  check('headless-plain: no control request left the process (no prompt tool)', run.controlRequests.length === 0)
  const texts = resultTexts(run)
  check('headless-plain: the turn settled with the seat\'s honest report', texts.length === 1 && texts[0]!.includes('agent-bash: reported not-a-sha'), JSON.stringify(texts))
  if (failures > before || KEEP) console.log(`  stderr tail: ${run.stderr.slice(-600)}`)
  keepOrDrop(world, 'headless-plain')
}

// ── run ─────────────────────────────────────────────────────────────────────
const LEG = process.env.AB_LEG ?? 'all'
const ORDER = ['default-fg', 'default-bg', 'flow-fg', 'openai-fg', 'headless-stdio', 'headless-plain']
const wanted = LEG === 'all' ? ORDER : LEG.split(',').map(s => s.trim())
for (const name of wanted) {
  if (name === 'headless-stdio') await runHeadlessStdio()
  else if (name === 'headless-plain') await runHeadlessPlain()
  else if (PTY_LEGS[name]) await runPtyLeg(PTY_LEGS[name]!)
  else {
    console.log(`  [FAIL] unknown leg ${name} (legs: ${ORDER.join(', ')})`)
    failures++
  }
}

console.log(failures === 0 ? '\nprove-agent-bash-live: ALL LAWS HOLD' : `\nprove-agent-bash-live: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
