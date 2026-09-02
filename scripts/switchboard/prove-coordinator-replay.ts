#!/usr/bin/env bun
// ============================================================================
//  prove-coordinator-replay — the durable conversation replays as what it is:
//  the harness in the harness's voice, old turns wearing their age, and a
//  request the harness settled as history rather than an open ask.
//
//  The incidents this closes (one live pane, one morning): a sign-in refusal
//  was stored AS the coordinator's own words and came back to the model as
//  something it had said; and a ten-hour-old "reply only" replayed with no
//  clock beside it, bound a fresh request, and the model answered a long-dead
//  question.
//
//    §1 THE SHAPER (pure, injected clock) — voice, age boundary, settled
//       pairing, tail bound.
//    §2 THE ROUND TRIP — a turn that cannot run stores its notice MARKED; a
//       turn that replies stores the model's words unmarked.
//    §3 THE NEXT TURN'S TAIL — the notice comes back as 'harness', the stale
//       ask carries its age, and the settled ask is flagged history.
//    §4 THE WIRE — that same tail, through the seat's real call path against a
//       loopback fixture, puts the notice in the history as a bracketed note
//       and never as an assistant turn.
//
//  Endpoint bases: the OpenAI API base pins to the loopback fixture; every
//  other base pins dead. Nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-coordinator-replay.ts
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
const scratch = mkdtempSync(join(tmpdir(), 'coordinator-replay-'))
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
process.env.OPENAI_API_KEY = 'sk-fixture-coordinator-replay'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback Responses fixture (GET /models + POST /responses) ──────────
type Captured = { url: string; body?: Record<string, unknown> }
const captured: Captured[] = []
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text'],
      supported_in_api: true,
    },
  ],
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const responsesSse = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_replay_1' } }),
    sse({ type: 'response.output_text.delta', delta: 'ok' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_replay_1', usage: { input_tokens: 9, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } }),
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
console.log(' coordinator replay — whose voice, how old, still open?')
console.log('============================================================')

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const replay = await import('../../src/services/concourse/coordinatorReplay.ts')
const conv = await import('../../src/services/concourse/coordinatorConversation.ts')
const lane = await import('../../src/services/concourse/coordinatorLane.ts')

// The lane only converses in agent-assisted mode; anything else answers the
// self-managed-launch signal and never stores a coordinator row at all.
const ASSIST_MODEL = 'claude-sonnet-5'
saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: ASSIST_MODEL } }))
lane._resetCoordinatorLaneForTesting()
mkdirSync(join(scratch, 'crew'), { recursive: true })

const HOUR = 3_600_000

//
section('§1 — the shaper: voice, age, settled, bound')
//
{
  const now = 1_700_000_000_000
  const rows = replay.buildCoordinatorReplay(
    [
      { id: 'op:a', role: 'operator', text: 'reply only — do not launch', ts: now - 10 * HOUR },
      { id: 'co:a', role: 'coordinator', text: 'The turn did not run: not signed in.', ts: now - 10 * HOUR, harness: true },
      { id: 'op:b', role: 'operator', text: 'what is running?', ts: now - 60_000 },
      { id: 'co:b', role: 'coordinator', text: 'Two sessions, both working.', ts: now - 30_000 },
    ],
    now,
  )
  check('four rows survive', rows.length === 4, JSON.stringify(rows))
  check("the harness notice is its OWN voice, never 'coordinator'", rows[1]?.role === 'harness', JSON.stringify(rows[1]))
  check('…and the model’s own reply stays the coordinator', rows[3]?.role === 'coordinator', JSON.stringify(rows[3]))
  check('a ten-hour-old turn wears its age', rows[0]?.age === '10h earlier', String(rows[0]?.age))
  check('a turn inside the freshness window wears none', rows[2]?.age === undefined && rows[3]?.age === undefined, JSON.stringify([rows[2]?.age, rows[3]?.age]))
  check('the ask the harness settled is flagged history', rows[0]?.settled === true, JSON.stringify(rows[0]))
  check('…and an ask the coordinator answered is NOT', rows[2]?.settled === undefined, JSON.stringify(rows[2]))
  // The boundary itself, from both sides — a floor that drifts is a silent
  // regression of exactly the class this closes.
  const edge = (deltaMs: number): string | undefined =>
    replay.buildCoordinatorReplay([{ id: 'op:e', role: 'operator', text: 'x', ts: now - deltaMs }], now)[0]?.age
  check('inside the floor: no age', edge(replay.REPLAY_AGE_FLOOR_MS - 1_000) === undefined)
  check('past the floor: an age', typeof edge(replay.REPLAY_AGE_FLOOR_MS + 61_000) === 'string')
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `op:${i}`, role: 'operator' as const, text: `m${i}`, ts: now }))
  check('the tail stays bounded', replay.buildCoordinatorReplay(many, now).length === replay.REPLAY_TAIL)
  check('…and it is the NEWEST turns', replay.buildCoordinatorReplay(many, now)[replay.REPLAY_TAIL - 1]?.text === 'm39')
  // THE SUMMARY RIDES THE TAIL (FN-017 rank 2): the fold seats its summary
  // at position 0; two operator exchanges later the twelve-entry tail slid
  // past it and the coordinator forgot everything before the last twelve
  // raw entries. The newest summary rides ahead of the tail once excluded.
  const folded = [
    { id: 'co:sum', role: 'coordinator' as const, text: 'SUMMARY: the folded turns — three launches, one standing ask', ts: now, summary: true as const },
    ...Array.from({ length: 13 }, (_, i) => ({ id: `op:s${i}`, role: 'operator' as const, text: `after ${i}`, ts: now })),
  ]
  const withSummary = replay.buildCoordinatorReplay(folded as never, now)
  check('THE COMPACT SUMMARY RIDES AHEAD OF THE TAIL once the slice excluded it (the base dropped it)', withSummary[0]?.text.startsWith('SUMMARY:') === true && withSummary.length === replay.REPLAY_TAIL + 1, JSON.stringify(withSummary.map(r => r.text.slice(0, 12))))
  check('…the tail behind it is still the newest turns', withSummary[withSummary.length - 1]?.text === 'after 12')
  check('…and it is never doubled while still inside the tail', replay.buildCoordinatorReplay(folded.slice(0, 5) as never, now).filter(r => r.text.startsWith('SUMMARY:')).length === 1)
}

//
section('§2 — the round trip: a notice is STORED marked, a reply is not')
//
{
  const failed = await lane.runOperatorMessageTurn(
    'launch one on the parser',
    {
      crewDir: join(scratch, 'crew'),
      callModel: async () => {
        throw new Error('Not logged in · Please run /logins')
      },
    },
    { clientMessageId: 'replay-refused' },
  )
  check('the turn refused', 'outcome' in failed && failed.outcome === 'refused', JSON.stringify(failed))
  const afterFail = await conv.readCoordinatorConversation()
  const notice = afterFail.find(e => e.id === 'co:replay-refused')
  check('the notice says the turn did not run', notice?.text.includes('The turn did not run') === true, notice?.text)
  check('…and it carries the sign-in refusal verbatim', notice?.text.includes('Please run /logins') === true, notice?.text)
  check('…STORED as the harness, never as the coordinator’s words', notice?.harness === true, JSON.stringify(notice))

  const spoke = await lane.runOperatorMessageTurn(
    'what is running?',
    {
      crewDir: join(scratch, 'crew'),
      callModel: async () => ({ decisions: [], reply: 'Nothing is running right now.' }),
    },
    { clientMessageId: 'replay-answered' },
  )
  check('the second turn executed', 'outcome' in spoke && spoke.outcome === 'executed', JSON.stringify(spoke))
  const reply = (await conv.readCoordinatorConversation()).find(e => e.id === 'co:replay-answered')
  check('the model’s own reply is stored as the coordinator', reply?.harness === undefined, JSON.stringify(reply))
}

//
section('§3 — the next turn’s tail carries all three facts')
//
let capturedTail: NonNullable<import('../../src/services/concourse/coordinatorLane.ts').CoordinatorTurnInput['conversation']> = []
{
  // A stale ask, ten hours back, exactly the shape that bound a fresh request.
  await conv.appendCoordinatorConversation({
    id: 'op:stale-ask',
    role: 'operator',
    text: 'reply only — do not launch anything',
    ts: Date.now() - 10 * HOUR,
  })
  await lane.runOperatorMessageTurn(
    'and the docs half?',
    {
      crewDir: join(scratch, 'crew'),
      callModel: async input => {
        capturedTail = [...(input.conversation ?? [])]
        return { decisions: [], reply: 'On it.' }
      },
    },
    { clientMessageId: 'replay-third' },
  )
  const notice = capturedTail.find(r => r.text.includes('The turn did not run'))
  check('the notice replays as the harness', notice?.role === 'harness', JSON.stringify(notice))
  check('…never as a coordinator turn', !capturedTail.some(r => r.role === 'coordinator' && r.text.includes('The turn did not run')))
  const stale = capturedTail.find(r => r.text.startsWith('reply only'))
  check('the ten-hour-old ask replays WITH its age', typeof stale?.age === 'string' && /earlier$/.test(stale.age), JSON.stringify(stale))
  const settledAsk = capturedTail.find(r => r.text.startsWith('launch one on the parser'))
  check('the ask the harness settled replays as history', settledAsk?.settled === true, JSON.stringify(settledAsk))
  const answeredAsk = capturedTail.find(r => r.text === 'what is running?')
  check('…and the ask that got a real answer does not', answeredAsk !== undefined && answeredAsk.settled === undefined, JSON.stringify(answeredAsk))
}

//
section('§4 — the wire: a notice is a bracketed note, never an assistant turn')
//
{
  const { liveCoordinatorCallModel } = await import('../../src/services/concourse/coordinatorCall.ts')
  const before = captured.length
  await liveCoordinatorCallModel(
    {
      contractVersion: lane.COORDINATOR_CONTRACT_VERSION,
      contract: lane.COORDINATOR_CONTRACT,
      event: { kind: 'operator-message', messageId: 'replay-wire', text: 'anything for me?' },
      board: { counts: {}, sessions: [], openObligations: [] },
      conversation: capturedTail,
    },
    'gpt-5.6-sol',
  )
  const responses = captured.slice(before).filter(c => c.url === '/responses')
  check('exactly ONE call settled the turn', responses.length === 1, String(responses.length))
  const body = responses[0]?.body ?? {}
  const wire = JSON.stringify(body.input ?? body)
  check('the notice rides the history as a bracketed harness note', wire.includes('[harness'), wire.slice(0, 300))
  check('…carrying the refusal text', wire.includes('Please run /logins'), wire.slice(0, 300))
  // The assistant turns on the wire are what the model said. A harness notice
  // among them is the whole bug: it comes back as words the model believes
  // it wrote.
  const items = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  const assistantText = items
    .filter(i => i.role === 'assistant')
    .map(i => JSON.stringify(i))
    .join('\n')
  check('no assistant turn carries the harness notice', !assistantText.includes('The turn did not run'), assistantText.slice(0, 300))
  check('the coordinator’s own reply IS an assistant turn', assistantText.includes('Nothing is running right now'), assistantText.slice(0, 300))
  check('the stale ask rides with its age tag', /\[\d+[mhd] earlier\]/.test(wire), wire.slice(0, 300))
  check('the settled ask says it is not an open ask', wire.includes('not an open ask'), wire.slice(0, 300))
}

server.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(
  failures === 0
    ? '\n✅ prove-coordinator-replay — all checks pass'
    : '\n❌ prove-coordinator-replay — check(s) failed',
)
process.exit(failures)
