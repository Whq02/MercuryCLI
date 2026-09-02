#!/usr/bin/env bun
// ============================================================================
//  prove-seat-engine-identity — every seat's assembled prompt names Mercury
//  AND the engine it runs on, and the id in the prompt is the id the dispatch
//  stamps.
//
//  The incident this closes: the coordinator, with a model plainly selected in
//  the picker, answered with an engine name that is in no catalogue — because
//  the assembled prompt carried no engine information at all, so the answer
//  had nothing grounded to draw on. Identity is layered, never hidden: Mercury
//  is what the seat is, the resolved id is what it runs on, both stated.
//
//    §1 THE OWNER (pure) — one line, provider-neutral: an anthropic id, a GPT
//       id and an id no registry knows each come back naming Mercury and the
//       exact id verbatim.
//    §2 THE MAIN LOOP — the env block the interactive seat assembles carries
//       the line for the model it was assembled with.
//    §3 SUBAGENTS — the subagent env block carries it for the CHILD's model.
//    §4 THE COORDINATOR, LIVE — the seat's real call path settles against a
//       loopback fixture; the instructions on the wire carry the line, and the
//       id inside that line EQUALS the model the same request dispatched on.
//    §5 WORKERS — the concourse worker spec boots on the model admission
//       resolved, so the worker's own main-loop assembly (§2) states that id.
//
//  Endpoint bases: the OpenAI API base pins to the loopback fixture; every
//  other base pins dead (ANTHROPIC_BASE_URL + dummy token, ChatGPT and auth
//  bases, local probes off). Nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-seat-engine-identity.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'seat-engine-identity-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
process.env.OPENAI_API_KEY = 'sk-fixture-seat-engine'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback Responses fixture (GET /models + POST /responses) ──────────
type Captured = { url: string; body?: Record<string, unknown> }
const captured: Captured[] = []
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth' },
      ],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const responsesSse = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_seat_1' } }),
    sse({ type: 'response.output_text.delta', delta: 'ok' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_seat_1', usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = req.url ?? ''
    let body: Record<string, unknown> | undefined
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = undefined
    }
    if (req.method === 'GET' && url.startsWith('/models')) {
      captured.push({ url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method === 'POST' && url === '/responses') {
      captured.push({ url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse())
      return
    }
    captured.push({ url })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${port}`

console.log('============================================================')
console.log(' seat engine identity — Mercury, and the id it runs on')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { mercuryEngineIdentityLine } = await import('../../src/prompt/engineIdentity.ts')
const prompts = await import('../../src/constants/prompts.ts')

/** The id a seat's assembled prompt claims to run on — read back out of the
 *  engine line exactly as a reader would, so the equality below compares the
 *  PROMPT's id against the dispatch stamp, never two copies of one variable. */
const idInPrompt = (text: string): string | null => {
  const m = /the model you run through Mercury is `([^`]+)`/.exec(text)
  return m?.[1] ?? null
}

//
section('§1 — the owner: one line, any family, the exact id verbatim')
//
{
  for (const [label, id] of [
    ['an anthropic id', 'claude-opus-5'],
    ['a GPT id', 'gpt-5.6-sol'],
    ['an id no registry knows', 'some-local-server/qwen3-32b'],
  ] as const) {
    const line = mercuryEngineIdentityLine(id)
    check(`${label}: names Mercury as what the seat IS`, /Mercury is what you are/.test(line), line)
    check(`${label}: carries the exact id verbatim`, line.includes(`\`${id}\``), line)
    check(`${label}: the id reads back out of the line`, idInPrompt(line) === id, String(idInPrompt(line)))
  }
  const unknown = mercuryEngineIdentityLine('some-local-server/qwen3-32b')
  check(
    'an unknown id names no family and invents no name',
    !/Claude|GPT|Anthropic|OpenAI/i.test(unknown),
    unknown,
  )
  check(
    'the line tells the seat to answer with the id, and that Mercury is who it is',
    /name it plainly and exactly/.test(unknown) && /the answer is Mercury/.test(unknown),
    unknown,
  )
}

//
section('§2 — the main loop: the env block states the seat’s engine')
//
{
  const env = await prompts.computeSimpleEnvInfo('claude-opus-5')
  check('the main-loop env block carries the engine line', env.includes(mercuryEngineIdentityLine('claude-opus-5')), env.slice(0, 200))
  check('…and the id in it is the model the block was assembled with', idInPrompt(env) === 'claude-opus-5', String(idInPrompt(env)))
  const other = await prompts.computeSimpleEnvInfo('gpt-5.6-sol')
  check('a different seat model re-assembles onto that id', idInPrompt(other) === 'gpt-5.6-sol', String(idInPrompt(other)))
}

//
section('§3 — subagents: the child’s own model, not the parent’s')
//
{
  const sections = await prompts.enhanceSystemPromptWithEnvDetails(['<task prompt>'], 'claude-sonnet-5')
  const whole = sections.join('\n\n')
  check('the subagent env block carries the engine line', whole.includes(mercuryEngineIdentityLine('claude-sonnet-5')), whole.slice(-300))
  check('…with the CHILD’s resolved id', idInPrompt(whole) === 'claude-sonnet-5', String(idInPrompt(whole)))
  check('the task prompt still rides ahead of it', whole.indexOf('<task prompt>') !== -1 && whole.indexOf('<task prompt>') < whole.indexOf('Mercury is what you are'))
}

//
section('§4 — the coordinator, LIVE: prompt id === dispatch stamp')
//
{
  const { COORDINATOR_CONTRACT, COORDINATOR_CONTRACT_VERSION } = await import('../../src/services/concourse/coordinatorLane.ts')
  const { liveCoordinatorCallModel } = await import('../../src/services/concourse/coordinatorCall.ts')
  const MODEL = 'gpt-5.6-sol'
  const before = captured.length
  await liveCoordinatorCallModel(
    {
      contractVersion: COORDINATOR_CONTRACT_VERSION,
      contract: COORDINATOR_CONTRACT,
      event: { kind: 'operator-message', messageId: 'seat-1', text: 'what model are you?' },
      board: { counts: {}, sessions: [], openObligations: [] },
    },
    MODEL,
  )
  const responses = captured.slice(before).filter(c => c.url === '/responses')
  check('exactly ONE call settled the turn', responses.length === 1, String(responses.length))
  const body = responses[0]?.body ?? {}
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  check('the coordinator seat’s prompt carries the engine line', /Mercury is what you are/.test(instructions), instructions.slice(0, 200))
  // THE EQUALITY, one per seat: the id the prompt claims and the id the same
  // request dispatches on are read from two different places and compared.
  check(
    'the id in the prompt EQUALS the dispatch stamp',
    idInPrompt(instructions) !== null && idInPrompt(instructions) === body.model,
    `${String(idInPrompt(instructions))} vs ${String(body.model)}`,
  )
  const floorAt = instructions.indexOf('You are the Mercury coordinator')
  const engineAt = instructions.indexOf('Mercury is what you are')
  const personaAt = instructions.indexOf('Your seat is the Mercury switchboard')
  check('the seat floor still LEADS, the engine line behind it, the persona last', floorAt >= 0 && engineAt > floorAt && personaAt > engineAt, `${floorAt}/${engineAt}/${personaAt}`)
  check('still exactly ONE identity statement on the wire', (instructions.match(/^You are /gm) ?? []).length === 1, instructions.slice(0, 120))
}

//
section('§5 — workers: the spec boots on the model admission resolved')
//
{
  const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseSupervisor.ts')
  const spec = buildConcourseWorkerSpec({
    runnerId: 'w-seat-1',
    sessionId: 's-seat-1',
    workspaceId: scratch,
    modelKey: 'claude-opus-5',
    effort: 'high',
    cwd: scratch,
  })
  check('the worker spec carries the admitted model id', spec.model === 'claude-opus-5', String(spec.model))
  // The worker IS a full Mercury session, so its own prompt is §2's assembly
  // on that id — one owner, no second engine line for the daemon's children.
  const env = await prompts.computeSimpleEnvInfo(String(spec.model))
  check('…so the worker’s own prompt states that id', idInPrompt(env) === 'claude-opus-5', String(idInPrompt(env)))
}

server.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(
  failures === 0
    ? '\n✅ prove-seat-engine-identity — all checks pass'
    : '\n❌ prove-seat-engine-identity — check(s) failed',
)
process.exit(failures)
