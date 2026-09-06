#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const KEEP = process.env.FV_KEEP === '1'
const j = (v: unknown): string => JSON.stringify(v)

const ASK = 'flow-seat: run the shell probe'
const AGENT_ASK = 'flow-seat: delegate the shell probe'
const FOLLOW_UP = 'flow-seat: what did the agent report?'
const SEAT_BRIEF = 'flow-seat-agent: run the shell probe in the working directory and report the sha'
const PROBE_COMMIT = 'flow-seat-probe'
const WRITING_COMMAND = `git commit --allow-empty -q -m ${PROBE_COMMIT} && git rev-parse --short HEAD`
const BLOCK_REASON = 'flow-seat: the fixture classifier blocks the probe commit'
const MODEL = 'claude-opus-5'
const FIXTURE_API_KEY = 'fixture-key-000'
const POLICY_DENIAL_LEAD = 'Permission for this action has been denied. Reason: '
const NO_CARD_WORDS = 'cannot show the operator a consent card'
const UNREADABLE_DENIAL_WORDS = 'could not read its own verdict'
const UNREADABLE_ASK_WORDS = 'could not read its verdict from'

type Route = 'classifier' | 'parent' | 'parent-ack' | 'seat-1' | 'seat-done' | 'side'
type Verdict = 'block' | 'malformed'
interface Hit {
  n: number
  route: Route
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

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: string; text?: string }
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

function toolNamesOf(body: unknown): string[] {
  const tools = (body as { tools?: unknown[] })?.tools
  if (!Array.isArray(tools)) return []
  return tools.map(t => (typeof (t as { name?: unknown })?.name === 'string' ? (t as { name: string }).name : '')).filter(n => n !== '')
}

function userTextsOf(body: unknown): string[] {
  const out: string[] = []
  for (const m of (body as { messages?: unknown[] })?.messages ?? []) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user') continue
    const text = textOf(msg.content)
    if (text.trim() !== '') out.push(text)
  }
  return out
}

function resultTextsOf(body: unknown): string[] {
  const out: string[] = []
  for (const m of (body as { messages?: unknown[] })?.messages ?? []) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<{ type?: string; content?: unknown }>) {
      if (block.type === 'tool_result') out.push(textOf(block.content))
    }
  }
  return out
}

function routeOf(body: unknown): { route: Route; tools: string[]; results: string[] } {
  const tools = toolNamesOf(body)
  const results = resultTextsOf(body)
  if (tools.includes('classify_result')) return { route: 'classifier', tools, results }
  if (userTextsOf(body).some(text => text.includes('flow-seat-agent:'))) {
    return { route: results.length === 0 ? 'seat-1' : 'seat-done', tools, results }
  }
  if (tools.includes('Agent')) return { route: results.length === 0 ? 'parent' : 'parent-ack', tools, results }
  return { route: 'side', tools, results }
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }

function jsonAnswer(n: number, model: string, blocks: Block[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const content = blocks.map((block, index) =>
    block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool_use', id: `toolu_fv_${n}_${index}`, name: block.name, input: block.input },
  )
  return JSON.stringify({
    id: `msg_fv_${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 },
  })
}

function sseAnswer(n: number, model: string, blocks: Block[]): string {
  const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_fv_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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
        `event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fv_${n}_${index}`, name: block.name, input: {} } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`,
      )
    }
  })
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}

const firstLine = (text: string | undefined): string => (text ?? '').trim().split('\n')[0]?.trim() ?? ''
const isSha = (text: string): boolean => /^[0-9a-f]{7,12}$/.test(text)
const quoted = (text: string | undefined): string => (text ?? '').trim().replace(/\s+/g, ' ').slice(0, 220)

function classifierBlocks(verdict: Verdict): Block[] {
  if (verdict === 'block') {
    return [{ type: 'tool_use', name: 'classify_result', input: { thinking: 'The command writes a commit to the working directory.', shouldBlock: true, reason: BLOCK_REASON } }]
  }
  return [{ type: 'tool_use', name: 'classify_result', input: { thinking: 'The command writes a commit to the working directory.', shouldBlock: 'maybe', reason: 'flow-seat: an unreadable verdict' } }]
}

async function startFixture(opts: { agent: boolean; verdict: Verdict }): Promise<Fixture> {
  const hits: Hit[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
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
      const { route, tools, results } = routeOf(body)
      const n = hits.length + 1
      const streaming = (body as { stream?: unknown })?.stream === true
      hits.push({ n, route, streaming, model, tools, results, body })
      let blocks: Block[]
      switch (route) {
        case 'classifier':
          blocks = classifierBlocks(opts.verdict)
          break
        case 'parent':
          blocks = opts.agent
            ? [
                { type: 'text', text: 'flow-seat: delegating the shell probe' },
                { type: 'tool_use', name: 'Agent', input: { description: 'flow-seat-agent', prompt: SEAT_BRIEF, subagent_type: 'general-purpose', run_in_background: true } },
              ]
            : [{ type: 'tool_use', name: 'Bash', input: { command: WRITING_COMMAND, description: 'the probe commit and its sha' } }]
          break
        case 'parent-ack': {
          const last = results[results.length - 1]
          const serialized = JSON.stringify(body)
          const report = [...serialized.matchAll(/flow-seat-agent-done: (sha=[0-9a-f]+|not-a-sha)/g)].pop()
          blocks = [
            {
              type: 'text',
              text: opts.agent
                ? report
                  ? `flow-seat: reported ${report[1]}`
                  : 'flow-seat: launched; the report arrives with the next turn'
                : isSha(firstLine(last))
                  ? `flow-seat: reported sha=${firstLine(last)}`
                  : `flow-seat: reported not-a-sha (${quoted(last)})`,
            },
          ]
          break
        }
        case 'seat-1':
          blocks = [{ type: 'tool_use', name: 'Bash', input: { command: WRITING_COMMAND, description: 'the probe commit and its sha' } }]
          break
        case 'seat-done': {
          const last = results[results.length - 1]
          blocks = [{ type: 'text', text: isSha(firstLine(last)) ? `flow-seat-agent-done: sha=${firstLine(last)}` : `flow-seat-agent-done: not-a-sha (${quoted(last)})` }]
          break
        }
        default:
          blocks = [{ type: 'text', text: 'ok' }]
      }
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonAnswer(n, model, blocks))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(sseAnswer(n, model, blocks))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

interface World {
  home: string
  cwd: string
  sha: string
}

function seedWorld(): World {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'flow-seat-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'flow-seat-cwd-')))
  const git = (args: string[]): string => {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout.trim()
  }
  git(['init', '-q'])
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
  writeFileSync(join(home, 'settings.json'), JSON.stringify({}, null, 2) + '\n')
  return { home, cwd, sha }
}

function worldEnv(world: World, fixtureBase: string): NodeJS.ProcessEnv {
  return {
    HOME: world.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: world.home,
    MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
    MERCURY_TEAMS_DIR: join(world.home, 'teams'),
    MERCURY_TABULA_DIR: join(world.home, 'tabula'),
    MERCURY_TMPDIR: join(world.home, 'tmp'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_THINKING_BINDING: 'drop_block',
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

function headSha(cwd: string): string {
  return spawnSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}
function commitCount(cwd: string): string {
  return spawnSync('git', ['-C', cwd, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}

function dumpsOf(world: World): string[] {
  const root = join(world.home, 'tmp')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (dir.endsWith('auto-mode-classifier-errors') && name.endsWith('.txt')) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(root)
  return out
}

interface HeadlessRun {
  frames: Array<Record<string, unknown>>
  controlRequests: Array<Record<string, unknown>>
  stderr: string
  exit: number | null
}

function runStreamJson(world: World, fixture: Fixture, args: string[], turns: Array<{ prompt: string; waitFor?: () => boolean }>): Promise<HeadlessRun> {
  return new Promise(resolvePromise => {
    const child = spawn(nodeBin!, [DIST, ...args], { cwd: world.cwd, env: worldEnv(world, fixture.base) })
    const frames: Array<Record<string, unknown>> = []
    const controlRequests: Array<Record<string, unknown>> = []
    let stdout = ''
    let stderr = ''
    let consumed = 0
    let sent = 0
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
      if (sent >= turns.length) return
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
                response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updated_input: request.input } },
              }) + '\n',
            )
          }
        }
        if (frame.type === 'result' && sent >= turns.length) child.stdin.end()
      }
    })
    child.stderr.on('data', d => (stderr += String(d)))
    child.on('close', exit => finish(exit))
    child.on('error', () => finish(null))
    sendNext()
  })
}

const resultTexts = (run: HeadlessRun): string[] => run.frames.filter(f => f.type === 'result').map(f => String((f as { result?: unknown }).result ?? ''))

function evidence(fixture: Fixture, run: HeadlessRun): void {
  console.log(`  evidence · hits: ${fixture.hits.map(h => `${h.n}:${h.route}${h.streaming ? '' : '/json'}/${h.model}`).join(' ')}`)
  for (const hit of fixture.hits) {
    if (hit.results.length === 0) continue
    console.log(`  evidence · request ${hit.n} (${hit.route}) results: ${hit.results.map(r => j(r.replace(/\s+/g, ' ').slice(0, 260))).join(' · ')}`)
  }
  const asks = run.controlRequests.map(f => (f.request ?? {}) as Record<string, unknown>)
  console.log(`  evidence · control requests: ${asks.map(a => `${String(a.tool_name)}${a.agent_id ? ' agent_id=' + String(a.agent_id).slice(0, 18) + '…' : ' (no agent_id)'} reason=${j(String(a.decision_reason ?? '')).slice(0, 200)}`).join(' · ') || 'none'}`)
  console.log(`  evidence · results: ${resultTexts(run).map(t => j(t.slice(0, 200))).join(' · ')}`)
}

interface Leg {
  name: string
  agent: boolean
  verdict: Verdict
  channel: boolean
}

const LEGS: Record<string, Leg> = {
  'seat-block': { name: 'seat-block', agent: false, verdict: 'block', channel: true },
  'seat-agent-block': { name: 'seat-agent-block', agent: true, verdict: 'block', channel: true },
  'seat-unreadable': { name: 'seat-unreadable', agent: false, verdict: 'malformed', channel: true },
  'plain-unreadable': { name: 'plain-unreadable', agent: false, verdict: 'malformed', channel: false },
  'plain-block': { name: 'plain-block', agent: false, verdict: 'block', channel: false },
}

async function runLeg(leg: Leg): Promise<void> {
  console.log(`\n— leg ${leg.name} —`)
  const before = failures
  const fixture = await startFixture({ agent: leg.agent, verdict: leg.verdict })
  const world = seedWorld()
  const argv = [
    '-p',
    '--permission-mode',
    'flow',
    '--input-format=stream-json',
    '--output-format=stream-json',
    ...(leg.channel ? ['--permission-prompt-tool', 'stdio'] : []),
    '--model',
    MODEL,
    '--debug-file',
    join(world.home, 'debug.txt'),
  ]
  const turns = leg.agent
    ? [{ prompt: AGENT_ASK }, { prompt: FOLLOW_UP, waitFor: () => fixture.hits.some(h => h.route === 'seat-done') }]
    : [{ prompt: ASK }]
  let run: HeadlessRun
  try {
    run = await runStreamJson(world, fixture, argv, turns)
  } finally {
    await fixture.close()
  }
  evidence(fixture, run)
  const classifierHits = fixture.hits.filter(h => h.route === 'classifier')
  const asks = run.controlRequests.map(f => (f.request ?? {}) as Record<string, unknown>)
  const askJson = j(asks)
  const wireJson = j(fixture.hits.map(h => h.results))
  const texts = resultTexts(run)
  const after = headSha(world.cwd)
  const commits = commitCount(world.cwd)
  const doneHit = leg.agent ? fixture.hits.find(h => h.route === 'seat-done') : fixture.hits.find(h => h.route === 'parent-ack')
  const shellResult = doneHit?.results[doneHit.results.length - 1]
  const debugLog = existsSync(join(world.home, 'debug.txt')) ? readFileSync(join(world.home, 'debug.txt'), 'utf8') : ''
  const dumps = dumpsOf(world)

  check(`${leg.name}: the run settled (${turns.length} turn${turns.length === 1 ? '' : 's'}) and exited 0`, texts.length === turns.length && run.exit === 0, `${texts.length} result(s) · exit ${run.exit} · stderr ${j(run.stderr.slice(-300))}`)
  check(`${leg.name}: the shell's ask reached the classifier ${leg.verdict === 'malformed' ? 'twice — the one same-model retry' : 'once'}`, classifierHits.length === (leg.verdict === 'malformed' ? 2 : 1) && classifierHits.every(h => !h.streaming && h.model === MODEL), `${classifierHits.length} classifier call(s): ${classifierHits.map(h => `${h.model}${h.streaming ? '' : '/json'}`).join(' ')}`)

  if (leg.channel) {
    const expectedReason = leg.verdict === 'block' ? BLOCK_REASON : UNREADABLE_ASK_WORDS
    check(`${leg.name}: ONE can_use_tool request left the seat for the shell — the ask parked with the host`, asks.length === 1 && asks[0]?.tool_name === 'Bash' && String((asks[0]?.input as { command?: string })?.command).includes(PROBE_COMMIT), `${asks.length} request(s)`)
    check(`${leg.name}: the request carries the reason (${j(expectedReason)})`, askJson.includes(expectedReason), askJson.slice(0, 400))
    if (leg.verdict === 'malformed') {
      check(`${leg.name}: the reason names the classifier model`, askJson.includes(MODEL), askJson.slice(0, 400))
    }
    if (leg.agent) {
      check(`${leg.name}: the request carries the background agent's id`, typeof asks[0]?.agent_id === 'string' && String(asks[0]?.agent_id).length > 0, askJson.slice(0, 300))
    }
    check(`${leg.name}: the host's allow ran the shell — the probe commit landed and its sha came back`, isSha(firstLine(shellResult)) && firstLine(shellResult) === after && commits === '2' && after !== world.sha, `${j(quoted(shellResult))} · head ${after} · commits ${commits}`)
    check(`${leg.name}: no denial anywhere on the wire`, !wireJson.includes('has been denied') && !wireJson.includes(NO_CARD_WORDS) && !wireJson.includes('auto-denied'), wireJson.slice(0, 400))
  } else {
    check(`${leg.name}: no control request left the run (no channel)`, asks.length === 0, `${asks.length} request(s)`)
    check(`${leg.name}: the shell did not run (one commit, the sha unchanged)`, commits === '1' && after === world.sha, `head ${after} · commits ${commits}`)
    if (leg.verdict === 'block') {
      check(`${leg.name}: the block denies with the policy-denial words and the no-card note`, (shellResult ?? '').includes(POLICY_DENIAL_LEAD + BLOCK_REASON) && (shellResult ?? '').includes(NO_CARD_WORDS), j(quoted(shellResult)))
    } else {
      check(`${leg.name}: the denial says the check could not read its verdict and names the model`, (shellResult ?? '').includes(UNREADABLE_DENIAL_WORDS) && (shellResult ?? '').includes(MODEL), j(quoted(shellResult)))
      check(`${leg.name}: the denial never wears the policy-denial words`, !(shellResult ?? '').includes(POLICY_DENIAL_LEAD) && !(shellResult ?? '').includes('blocked this action'), j(quoted(shellResult)))
    }
  }

  if (leg.verdict === 'malformed') {
    check(`${leg.name}: the classifier error dump was written (${dumps.length})`, dumps.length >= 1, `${dumps.length} dump(s) under ${join(world.home, 'tmp')}`)
    const dump = dumps.join('\n')
    check(`${leg.name}: the dump names the failing field, the model, the stop reason and a request id`, dump.includes('shouldBlock') && dump.includes(MODEL) && dump.includes('stop_reason') && dump.includes('request id'), dump.slice(0, 600))
    check(`${leg.name}: the debug log carries the unreadable-verdict line, redacted (the field, never the value)`, debugLog.includes('classifier verdict unreadable') && debugLog.includes('shouldBlock') && !debugLog.includes('"maybe"'), debugLog.split('\n').filter(l => /classif/i.test(l)).slice(-4).join(' | ').slice(0, 500))
    check(`${leg.name}: the policy-denial words appear nowhere on the wire`, !wireJson.includes(POLICY_DENIAL_LEAD), wireJson.slice(0, 300))
  }

  if (failures > before || KEEP) console.log(`  stderr tail: ${run.stderr.slice(-800)}`)
  keepOrDrop(world, leg.name)
}

const ORDER = ['seat-block', 'seat-agent-block', 'seat-unreadable', 'plain-unreadable', 'plain-block']
const wanted = (process.env.FV_LEG ?? 'all') === 'all' ? ORDER : (process.env.FV_LEG ?? '').split(',').map(s => s.trim())
for (const name of wanted) {
  const leg = LEGS[name]
  if (!leg) {
    console.log(`  [FAIL] unknown leg ${name} (legs: ${ORDER.join(', ')})`)
    failures++
    continue
  }
  await runLeg(leg)
}

console.log(failures === 0 ? '\nprove-flow-verdict-seat: ALL LAWS HOLD' : `\nprove-flow-verdict-seat: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
