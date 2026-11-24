#!/usr/bin/env bun
// gate-watch: src/sessions/mneme/handoffAsk.ts src/models/roads/anthropic/messageEffort.ts src/models/roads/anthropic/stream-core/wireParams.ts src/models/roads/anthropic/stream-core/passRetries.ts src/engine/requests/withRetry.ts src/models/facts/capabilities.ts src/crew/agents/forkedAgent.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostRunner } from '../lib/runnerHost.ts'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_MAX_RETRIES|MERCURY_MODEL|MERCURY_OAUTH_TOKEN|MERCURY_BARE|MERCURY_HOME|MERCURY_EFFORT_LEVEL|MERCURY_THINKING_BUDGET|MERCURY_THINKING_BINDING|MERCURY_THINKING_DISPLAY|MERCURY_CACHE_DIAGNOSTICS|MERCURY_EXTRA_BODY|MERCURY_PROVIDER_BETAS|MERCURY_PROMPT_CACHING|MERCURY_CACHE_TTL|MERCURY_DAEMON_PERMISSION_MODE)$/.test(key) ||
    /^(OPENAI|ZAI|OPENROUTER)_/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|OPENROUTER)_/.test(key) ||
    /^(https?_proxy|no_proxy)$/i.test(key)
  ) {
    delete process.env[key]
  }
}
const HOME = mkdtempSync(join(tmpdir(), 'handoff-low-effort-home-'))
const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-low-effort-project-')))
writeFileSync(join(PROJECT, 'README.md'), 'a project under proof\n')
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CACHE_CLOCK = '0'

let failures = 0
let checks = 0
const LOW_EFFORT_WHERE = 'the effort row and its header are built in src/models/roads/anthropic/messageEffort.ts and the ask is sent by askForHandoff in src/sessions/mneme/handoffAsk.ts; a build check needs dist/mercury.mjs built first'
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — where to look: ${LOW_EFFORT_WHERE}${detail ? ` — ${detail.slice(0, 900)}` : ''}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the handoff effort prover exceeded 240s; a fixture request never answered, so look at the last section printed above and at the ask in src/sessions/mneme/handoffAsk.ts')
  process.exit(1)
}, 240_000)
guard.unref?.()

const HEADER = 'mid-conversation-output-config-2026-07-01'
const ROW = '{"role":"system","content":[],"output_config":{"effort":"low"}}'
const PREVIOUS = 'The work: the write guard.\nDecided: a refused fact is refused whole.\nStill to do: the novelty proof.'
const NOTE = 'The fold lands tonight.\nThe effort proof is green.'
const NOTE_REPEAT = 'The work: a different task entirely.\nDecided: a refused fact is refused whole.\nStill to do: the novelty proof.'
const NOTE_SECOND = 'nothing new since the last note'
const NOTE_LATER = 'The provider answered 400 to the row once.\nThe later exit asked without it.'
const REFUSALS = [
  'messages.3.output_config: Extra inputs are not permitted',
  'output_config.effort requires a model that supports per-turn effort; this model does not',
  'Unexpected value(s) `mid-conversation-output-config-2026-07-01` for the `anthropic-beta` header. Please consult our documentation at platform.claude.com/docs or try again without the header.',
  'the request was refused in words no page of the provider holds',
]
const LATER_REFUSAL = 'a refusal of another kind, answered to a request that carried no row'
const TWICE_ARG = '--refused-twice'
const REFUSAL_MARK = 'REFUSAL-LEG '
const refusalAt = process.argv.indexOf('--refusal')
const REFUSAL = refusalAt === -1 ? null : REFUSALS[Number(process.argv[refusalAt + 1])] ?? LATER_REFUSAL
if (process.argv.includes('--no-retries')) process.env.MERCURY_MAX_RETRIES = '0'

const { HANDOFF_ASK_MARK, handoffTurn, startFixtureApi } = await import('../lib/fixtureApi.ts')
const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
type Turn = Parameters<typeof startFixtureApi>[0][number]
const plain = (n: number): Turn[] => Array.from({ length: n }, (_, i) => ({ kind: 'text' as const, text: `fixture reply ${i + 1}` }))
const api = await startFixtureApi([
  { kind: 'text', text: 'ANSWER-ONE', whenBody: 'first probe' },
  handoffTurn(NOTE),
  { kind: 'text', text: 'ANSWER-TWO', whenBody: 'second probe' },
  handoffTurn(NOTE_REPEAT),
  handoffTurn(NOTE_SECOND),
  ...plain(80),
])
const refusing = await startFixtureApi(REFUSAL === LATER_REFUSAL
  ? [
      { kind: 'text', text: 'ANSWER-THREE', whenBody: 'third probe' },
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: LATER_REFUSAL, whenBody: HANDOFF_ASK_MARK },
      ...plain(8),
    ]
  : [
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: REFUSAL ?? REFUSALS[0]!, whenBody: '"role":"system"' },
      { kind: 'text', text: 'ANSWER-THREE', whenBody: 'third probe' },
      ...(process.argv.includes(TWICE_ARG) ? [{ kind: 'error' as const, status: 400, errorType: 'invalid_request_error', message: LATER_REFUSAL, whenBody: HANDOFF_ASK_MARK }] : []),
      handoffTurn(NOTE),
      { kind: 'text', text: 'ANSWER-FOUR', whenBody: 'fourth probe' },
      handoffTurn(NOTE_LATER),
      { kind: 'text', text: 'ANSWER-FIVE', whenBody: 'fifth probe' },
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: LATER_REFUSAL, whenBody: HANDOFF_ASK_MARK },
      ...plain(8),
    ])
const families = await startCrossfamilyFixture({ port: 0, gptReasoningLevels: ['low', 'medium', 'high'] })

let upstream = api.port
const proxy = http.createServer((req, res) => {
  const target = new URL(req.url ?? '/', 'http://api.anthropic.com')
  const forward = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers }, answer => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  forward.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(forward)
})
const proxyPort = await new Promise<number>(resolve => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as net.AddressInfo).port)))
const PROXY = `http://127.0.0.1:${proxyPort}`

const wireFetch = globalThis.fetch
const leftTheMachine: string[] = []
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const through = (init as { proxy?: unknown } | undefined)?.proxy
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && through !== PROXY) {
    leftTheMachine.push(url.host)
    return Promise.reject(new Error(`the proof lets no request leave the machine: ${url.host}`))
  }
  return wireFetch(input, init)
}) as typeof fetch

Object.assign(process.env, families.env)
function address(kind: 'first-party' | 'third-party'): void {
  if (kind === 'first-party') {
    process.env.ANTHROPIC_BASE_URL = 'http://api.anthropic.com'
    process.env.HTTP_PROXY = PROXY
    return
  }
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream}`
  delete process.env.HTTP_PROXY
}

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { askForHandoff, _resetHandoffAskForTesting } = await import('../../src/sessions/mneme/handoffAsk.ts')
const { noteSessionEngine, _resetLineageSessionForTesting } = await import('../../src/sessions/mneme/lineageSession.ts')
const { ledgerEntryOf, openEntry, closeEntry } = await import('../../src/sessions/mneme/ledger.ts')
const { mnemeProjectKey } = await import('../../src/sessions/mneme/paths.ts')
const { getLastCacheSafeParams, runForkedAgent } = await import('../../src/crew/agents/forkedAgent.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')
const { turnDoor: startTurn } = await import('../../src/engine/turnDoor.ts')

const posture = asSystemPrompt(['You are a fixture-driven session posture.'])
const deny = (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never
type Row = { type: string; uuid?: string; message?: { content?: unknown }; replyEffort?: string }
type Captured = { headers: Record<string, string>; body: { model?: string; output_config?: unknown; tools?: unknown; system?: unknown; thinking?: unknown; tool_choice?: unknown; messages?: Array<{ role: string; content: unknown; output_config?: unknown }> }; raw: string }

function makeContext(model: string, effort: string | undefined): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  let appState: Record<string, unknown> = { toolPermissionContext, sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: effort }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { appState = next(appState) },
    messages: [],
    agentType: undefined,
    agentId: undefined,
    startTurn,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: { tools: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  }
}

const sent = (fixture: typeof api): Captured[] => fixture.messageRequests().filter(r => !r.path.includes('count_tokens')) as unknown as Captured[]
let sessions = 0
function freshSession(model: string, previousNote?: string): string {
  const id = `00000000-0000-4000-8000-${String(++sessions).padStart(12, '0')}`
  _resetHandoffAskForTesting()
  _resetLineageSessionForTesting()
  if (previousNote !== undefined) {
    openEntry(mnemeProjectKey(), { sessionId: `earlier-${id}`, model })
    closeEntry(mnemeProjectKey(), `earlier-${id}`, { outcome: 'closed', handoff: previousNote })
  }
  switchSession(id as never)
  noteSessionEngine(model)
  return id
}

async function sessionTurn(context: Record<string, unknown>, history: Row[], prompt: string): Promise<Row[]> {
  const messages = [...history, createUserMessage({ content: prompt }) as Row]
  const rows = [...messages]
  const turn = startTurn({ messages: messages as never, systemPrompt: posture, userContext: {}, systemContext: {}, canUseTool: deny, toolUseContext: context as never, querySource: 'sdk' })
  for await (const row of turn) {
    const kind = (row as Row).type
    if (kind === 'assistant' || kind === 'user' || kind === 'attachment') rows.push(row as Row)
  }
  return rows
}

async function session(fixture: typeof api, model: string, effort: string | undefined, prompt: string, previousNote?: string): Promise<{ id: string; context: Record<string, unknown>; rows: Row[]; turn: Captured; asks: Captured[]; note: Awaited<ReturnType<typeof askForHandoff>> }> {
  const id = freshSession(model, previousNote)
  const context = makeContext(model, effort)
  const from = sent(fixture).length
  const rows = await sessionTurn(context, [], prompt)
  const turn = sent(fixture)[from]!
  const params = getLastCacheSafeParams()
  const note = params === null ? null : await askForHandoff({ cacheSafeParams: params, sessionId: id, budgetMs: 60_000 })
  return { id, context, rows, turn, asks: sent(fixture).slice(from + 1), note }
}

let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function assistantRow(text: string, model: string): Row {
  const id = `msg_${nextUuid().slice(-6)}`
  return { type: 'assistant', uuid: nextUuid(), requestId: `req_${id}`, timestamp: new Date().toISOString(), message: { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } } } as Row
}
async function forkWire(captured: () => unknown[], model: string, effort: string | undefined, marked: boolean): Promise<{ raw: string; captured: Captured | undefined; said: string }> {
  const history = [createUserMessage({ content: 'please bump the version and run the tests', uuid: '00000000-0000-4000-b000-000000000001', timestamp: '2026-11-19T00:00:00.000Z' }), { ...assistantRow('Bumped the version and ran the suite.', model), uuid: '00000000-0000-4000-b000-000000000002', timestamp: '2026-11-19T00:00:01.000Z', requestId: 'req_fixed', message: { ...assistantRow('', model).message, id: 'msg_fixed', content: [{ type: 'text', text: 'Bumped the version and ran the suite.' }] } }]
  const ask = createUserMessage({ content: 'Summarise the conversation so far in one line.', isMeta: true, uuid: '00000000-0000-4000-b000-000000000003', timestamp: '2026-11-19T00:00:02.000Z' })
  const from = captured().length
  const result = await runForkedAgent({
    promptMessages: [(marked ? { ...ask, replyEffort: 'low' } : ask) as never],
    cacheSafeParams: { systemPrompt: posture, userContext: {}, systemContext: {}, toolUseContext: makeContext(model, effort) as never, forkContextMessages: history as never },
    canUseTool: deny,
    querySource: 'side_question',
    forkLabel: 'handoff',
    overrides: { agentId: 'a0000000000000000' as never },
    maxTurns: 2,
    skipCacheWrite: true,
    skipTranscript: true,
  })
  const hit = captured()[from] as Captured | { body?: unknown } | undefined
  const raw = hit === undefined ? '' : 'raw' in hit ? hit.raw : j(hit.body)
  return { raw, captured: hit as Captured | undefined, said: j(result.messages.map(row => (row as Row).message?.content)).slice(0, 500) }
}
const anthropicHits = (): unknown[] => sent(api)
const beta = (request: Captured | undefined): string[] => (request?.headers['anthropic-beta'] ?? '').split(',').filter(Boolean)

if (REFUSAL === LATER_REFUSAL) {
  upstream = refusing.port
  address('first-party')
  const plainAsk = await session(refusing, 'claude-opus-4-8', 'max', 'third probe')
  console.log(REFUSAL_MARK + j({ asks: plainAsk.asks.length, rows: plainAsk.asks.filter(ask => ask.raw.includes('"role":"system"')).length, note: plainAsk.note, left: leftTheMachine }))
  process.exit(0)
}
if (REFUSAL !== null && process.argv.includes(TWICE_ARG)) {
  upstream = refusing.port
  address('first-party')
  const twice = await session(refusing, 'claude-opus-5-5', 'max', 'third probe')
  console.log(REFUSAL_MARK + j({ asks: twice.asks.length, rows: twice.asks.map(ask => ask.raw.includes('"role":"system"')), note: twice.note, left: leftTheMachine }))
  process.exit(0)
}
if (REFUSAL !== null) {
  upstream = refusing.port
  address('first-party')
  const three = await session(refusing, 'claude-opus-5-5', 'max', 'third probe')
  const [refused, again] = three.asks
  const four = await session(refusing, 'claude-opus-5-5', 'max', 'fourth probe')
  const five = await session(refusing, 'claude-opus-5-5', 'max', 'fifth probe')
  console.log(REFUSAL_MARK + j({
    unrelatedAsks: five.asks.length,
    unrelatedNote: five.note,
    asks: three.asks.length,
    carried: j(refused?.body.messages?.at(-1)) === ROW && beta(refused).includes(HEADER),
    againIsTheBase: again !== undefined && again.raw === refused!.raw.replace(`,${ROW}`, '') && j(beta(again)) === j(beta(refused).filter(value => value !== HEADER)),
    note: three.note,
    laterAsks: four.asks.length,
    laterPlain: four.asks.length === 1 && !four.asks[0]!.raw.includes('"role":"system"') && !beta(four.asks[0]).includes(HEADER),
    laterNote: four.note,
    left: leftTheMachine,
  }))
  process.exit(0)
}

section('§1 Opus 5.5 at max on the first-party address: the ask keeps the session\'s request and gains one row after itself')
address('first-party')
const one = await session(api, 'claude-opus-5-5', 'max', 'first probe')
{
  const turn = one.turn
  const ask = one.asks[0]
  const lead = turn?.body.messages ?? []
  const rows = ask?.body.messages ?? []
  check('the turn and one ask reached the fixture through the first-party address', turn !== undefined && one.asks.length === 1 && ask!.raw.includes(HANDOFF_ASK_MARK) && leftTheMachine.length === 0, `asks=${one.asks.length} left=${j(leftTheMachine)}`)
  check('the session\'s turn carries the session\'s effort at the request level', j(turn?.body.output_config) === '{"effort":"max"}', j(turn?.body.output_config))
  check('the ask carries the same request-level effort, byte for byte', j(ask?.body.output_config) === j(turn?.body.output_config), j(ask?.body.output_config))
  check('tools, system, model, thinking and tool_choice of the ask are the turn\'s, byte for byte', j(ask?.body.tools) === j(turn?.body.tools) && j(ask?.body.system) === j(turn?.body.system) && ask?.body.model === turn?.body.model && j(ask?.body.thinking) === j(turn?.body.thinking) && j(ask?.body.tool_choice) === j(turn?.body.tool_choice), j({ model: [ask?.body.model, turn?.body.model], thinking: [ask?.body.thinking, turn?.body.thinking] }))
  check('every message the turn sent leads the ask, byte for byte, the cache mark on the same block', lead.length > 0 && j(rows.slice(0, lead.length)) === j(lead) && j(lead).includes('cache_control'), j(rows.slice(0, lead.length)).slice(0, 400))
  check('after them come the reply, the ask, and the effort row as the last of the request', j(rows.slice(lead.length).map(row => row.role)) === '["assistant","user","system"]' && j(rows.at(-1)) === ROW && j(rows.at(-2)).includes(HANDOFF_ASK_MARK), j(rows.slice(lead.length).map(row => row.role)))
  check('the row is on the wire in the page\'s own bytes, once', ask !== undefined && ask.raw.split(ROW).length === 2 && ask.raw.split('"role":"system"').length === 2, String(ask?.raw.split('"role":"system"').length))
  check('the header rides the ask and not the turn, and the ask\'s other header values are the turn\'s', beta(ask).includes(HEADER) && !beta(turn).includes(HEADER) && j(beta(ask).filter(value => value !== HEADER)) === j(beta(turn)), j({ ask: beta(ask), turn: beta(turn) }))
  check('the note is stored as written', one.note?.text === NOTE && one.note.stored === true && one.note.reasked === false && ledgerEntryOf(mnemeProjectKey(), one.id)?.handoff?.text === NOTE, j(one.note))
}

section('§2 the re-ask: the row stays where it was and no second one is sent')
const two = await session(api, 'claude-opus-5-5', 'max', 'second probe', PREVIOUS)
{
  const [first, second] = two.asks
  const firstRows = first?.body.messages ?? []
  const secondRows = second?.body.messages ?? []
  const at = firstRows.findIndex(row => row.role === 'system')
  check('a note that repeats the record brings one re-ask: two asks, the second note stored', two.asks.length === 2 && two.note?.reasked === true && two.note.text === NOTE_SECOND && two.note.stored === true, j({ asks: two.asks.length, note: two.note }))
  check('the first ask ends on the row', at === firstRows.length - 1 && j(firstRows[at]) === ROW, j(firstRows.map(row => row.role)))
  check('the re-ask holds one row, at the same place, with the first note and the re-ask after it', secondRows.filter(row => row.role === 'system').length === 1 && j(secondRows[at]) === ROW && j(secondRows.slice(at + 1).map(row => row.role)) === '["assistant","user"]' && j(secondRows.slice(0, at).map(row => row.role)) === j(firstRows.slice(0, at).map(row => row.role)), j(secondRows.map(row => row.role)))
  check('the re-ask keeps the request-level effort and the header', j(second?.body.output_config) === '{"effort":"max"}' && beta(second).includes(HEADER), j({ effort: second?.body.output_config, beta: beta(second) }))
}

section('§3 the page\'s list, name by name; a model outside it sends the request it sent without the field')
for (const model of ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
  const marked = await forkWire(anthropicHits, model, 'high', true)
  const rows = marked.captured?.body.messages ?? []
  check(`${model}: the row follows the ask and the header rides`, j(rows.at(-1)) === ROW && rows.at(-2)?.role === 'user' && beta(marked.captured).includes(HEADER) && j(marked.captured?.body.output_config) === '{"effort":"high"}', j({ roles: rows.map(row => row.role), beta: beta(marked.captured), effort: marked.captured?.body.output_config }))
}
for (const model of ['claude-fable-5', 'claude-mythos-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
  const marked = await forkWire(anthropicHits, model, 'high', true)
  const bare = await forkWire(anthropicHits, model, 'high', false)
  check(`${model}: with the field or without, the same bytes and the same header`, marked.raw !== '' && marked.raw === bare.raw && !marked.raw.includes('"role":"system"') && !beta(marked.captured).includes(HEADER) && j(beta(marked.captured)) === j(beta(bare.captured)), j({ same: marked.raw === bare.raw, beta: beta(marked.captured) }))
}

section('§4 a session already at low sends no row; a session with no effort of its own sends one')
{
  const marked = await forkWire(anthropicHits, 'claude-opus-5-5', 'low', true)
  const bare = await forkWire(anthropicHits, 'claude-opus-5-5', 'low', false)
  check('at low: the same bytes with the field or without, no header', marked.raw !== '' && marked.raw === bare.raw && !beta(marked.captured).includes(HEADER) && j(marked.captured?.body.output_config) === '{"effort":"low"}', j({ same: marked.raw === bare.raw, effort: marked.captured?.body.output_config }))
  const medium = await forkWire(anthropicHits, 'claude-opus-5-5', 'medium', true)
  check('at medium: the row rides and the request level stays medium', j(medium.captured?.body.messages?.at(-1)) === ROW && j(medium.captured?.body.output_config) === '{"effort":"medium"}', j(medium.captured?.body.output_config))
}

section('§5 a third-party address: the request it sent without the field')
address('third-party')
{
  const marked = await forkWire(anthropicHits, 'claude-opus-5-5', 'max', true)
  const bare = await forkWire(anthropicHits, 'claude-opus-5-5', 'max', false)
  check('with the field or without, the same bytes and no header', marked.raw !== '' && marked.raw === bare.raw && !marked.raw.includes('"role":"system"') && !beta(marked.captured).includes(HEADER), j({ same: marked.raw === bare.raw, beta: beta(marked.captured) }))
}

section('§6 the other roads never see the field: OpenAI Responses, the shared chat road, Z.AI')
for (const [label, lane, model] of [['OpenAI Responses', 'openai-seat', 'gpt-5.5'], ['the shared chat road (OpenRouter)', 'openrouter-seat', 'openrouter/nvidia/nemotron-nano-9b-v2:free'], ['Z.AI', 'zai-seat', 'glm-5.2']] as const) {
  const hits = (): unknown[] => families.captured.filter(hit => hit.lane === lane)
  const marked = await forkWire(hits, model, 'high', true)
  const bare = await forkWire(hits, model, 'high', false)
  check(`${label}: with the field or without, the same request`, marked.raw !== '' && marked.raw === bare.raw && !marked.raw.includes('replyEffort') && !marked.raw.includes('"role":"system","content":[]'), j({ sent: marked.raw !== '', same: marked.raw === bare.raw, said: marked.said }))
}

address('first-party')

section('§7 the field rests nowhere: not in the session, not on disk, not in the session\'s next request')
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(HOME)
  const holding = files.filter(file => readFileSync(file).includes('replyEffort'))
  check('no file of the home holds the field after three sessions and their notes', files.length > 0 && holding.length === 0, j(holding))
  check('no message of the session holds it, nor the list the ask was forked from', !one.rows.some(row => row.replyEffort !== undefined) && !(getLastCacheSafeParams()?.forkContextMessages ?? []).some(row => (row as Row).replyEffort !== undefined))
  const from = sent(api).length
  await sessionTurn(one.context, one.rows, 'and one more thing')
  const next = sent(api)[from]
  check('the session\'s next turn sends no row and no header, at the session\'s effort', next !== undefined && !next.raw.includes('"role":"system"') && !beta(next).includes(HEADER) && j(next.body.output_config) === '{"effort":"max"}', j({ beta: beta(next), effort: next?.body.output_config }))
}

section('§8 the provider answers 400 to the request that carries the row: the base\'s request goes out once, the note is kept, the process sends the row no more')
for (const [index, words, flags] of [...REFUSALS.entries()].map(([at, text]) => [at, text, []] as const).concat([[0, `${REFUSALS[0]!.slice(0, 20)} (MERCURY_MAX_RETRIES=0)`, ['--no-retries']] as never])) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--refusal', String(index), ...flags], { encoding: 'utf8', timeout: 120_000 })
  const line = child.stdout.split('\n').find(row => row.startsWith(REFUSAL_MARK))
  const leg = line === undefined ? null : JSON.parse(line.slice(REFUSAL_MARK.length)) as { asks: number; carried: boolean; againIsTheBase: boolean; note: { text: string; stored: boolean } | null; laterAsks: number; laterPlain: boolean; laterNote: { text: string; stored: boolean } | null; unrelatedAsks: number; unrelatedNote: unknown; left: string[] }
  const said = `400 "${words.slice(0, 44)}${words.length > 44 ? '…' : ''}"`
  check(`${said}: the ask with the row, then the ask as the base sends it (no row, no header, nothing else moved)`, leg !== null && leg.asks === 2 && leg.carried && leg.againIsTheBase && leg.left.length === 0, line ?? `${child.status} ${child.stderr.slice(-400)}`)
  check(`${said}: the note is stored, and a later exit of the same process asks once without the row`, leg !== null && leg.note?.text === NOTE && leg.note.stored === true && leg.laterAsks === 1 && leg.laterPlain && leg.laterNote?.text === NOTE_LATER && leg.laterNote.stored === true, line ?? '')
  check(`${said}: a 400 answered afterwards to an ask that carried no row is not sent again`, leg !== null && leg.unrelatedAsks === 1 && leg.unrelatedNote === null, line ?? '')
}
{
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--refusal', String(REFUSALS.length)], { encoding: 'utf8', timeout: 120_000 })
  const line = child.stdout.split('\n').find(row => row.startsWith(REFUSAL_MARK))
  const leg = line === undefined ? null : JSON.parse(line.slice(REFUSAL_MARK.length)) as { asks: number; rows: number; note: unknown; left: string[] }
  check('a 400 answered to an ask that never carried the row (Opus 4.8) is today\'s failure: one request, no note', leg !== null && leg.asks === 1 && leg.rows === 0 && leg.note === null && leg.left.length === 0, line ?? `${child.status} ${child.stderr.slice(-400)}`)
}

{
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--refusal', '0', TWICE_ARG], { encoding: 'utf8', timeout: 120_000 })
  const line = child.stdout.split('\n').find(row => row.startsWith(REFUSAL_MARK))
  const leg = line === undefined ? null : JSON.parse(line.slice(REFUSAL_MARK.length)) as { asks: number; rows: boolean[]; note: unknown; left: string[] }
  check('the resend answered 400 too is today\'s failure: two requests in all, the second without the row, no third, no note', leg !== null && leg.asks === 2 && j(leg.rows) === '[true,false]' && leg.note === null && leg.left.length === 0, line ?? `${child.status} ${child.stderr.slice(-400)}`)
}

section('§9 the built product: a hosted session leaves its note with the row, and resumed from its transcript it sends none')
{
  const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'dist', 'mercury.mjs')
  const nodeBin = Bun.which('node')
  if (!existsSync(DIST) || nodeBin === null) check('dist/mercury.mjs and a node binary present (build first; the gate prebuilds it)', false, DIST)
  else {
    const built = await startFixtureApi([{ kind: 'text', text: 'ANSWER-BUILT', whenBody: 'built probe' }, handoffTurn(NOTE), { kind: 'text', text: 'ANSWER-RESUMED', whenBody: 'and then' }, ...plain(6)])
    upstream = built.port
    const world = mkdtempSync(join(tmpdir(), 'handoff-low-effort-built-'))
    const home = join(world, 'home', '.mercury')
    const project = join(realpathSync(world), 'project')
    mkdirSync(home, { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'README.md'), 'a project under proof\n')
    const env = { HOME: join(world, 'home'), PATH: `/usr/bin:/bin:${dirname(nodeBin)}`, TERM: 'dumb', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(world, 'home', 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: 'http://api.anthropic.com', HTTP_PROXY: PROXY, http_proxy: PROXY }
    const host = hostRunner({ node: nodeBin, dist: DIST, cwd: project, home, env, argv: ['--model', 'claude-opus-5-5', '--effort', 'max'] })
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
    let exit: number | null = null
    try {
      await host.initialize()
      await host.prompt('built probe', { id: 'built-1' })
      await host.waitFor('the outcome row', row => row.type === 'outcome', 60_000)
      host.end()
      exit = await host.exited
    } finally {
      clearTimeout(killer)
      await host.stop()
    }
    const hosted = sent(built)
    const ask = hosted.find(request => request.raw.includes(HANDOFF_ASK_MARK))
    check('the hosted session: its turn, then one ask that ends on the row with the header, at the session\'s request-level effort', exit === 0 && hosted.length === 2 && j(ask?.body.messages?.at(-1)) === ROW && beta(ask).includes(HEADER) && !beta(hosted[0]).includes(HEADER) && j(ask?.body.output_config) === '{"effort":"max"}', j({ exit, requests: hosted.length, roles: ask?.body.messages?.map(row => row.role), beta: beta(ask), stderr: host.stderr().slice(0, 300) }))
    const resumedRun = Bun.spawn([nodeBin, DIST, 'run', '--continue', '--format', 'rows', '--model', 'claude-opus-5-5', '--effort', 'max', '--', 'and then?'], { env, cwd: project, stdout: 'pipe', stderr: 'pipe' })
    const [resumedOut, resumedErr, resumedExit] = await Promise.all([new Response(resumedRun.stdout).text(), new Response(resumedRun.stderr).text(), resumedRun.exited])
    const after = sent(built).slice(hosted.length)
    check('resumed from its transcript the session sends its history and no row, no header, no ask', resumedExit === 0 && /"resume_of":"[0-9a-f-]+"/.test(resumedOut) && after.length === 1 && after[0]!.raw.includes('built probe') && !after[0]!.raw.includes('"role":"system"') && !after[0]!.raw.includes(HANDOFF_ASK_MARK) && !beta(after[0]).includes(HEADER), j({ exit: resumedExit, requests: after.length, beta: beta(after[0]), stderr: resumedErr.slice(-300) }))
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (statSync(full).isFile()) files.push(full)
      }
    }
    walk(world)
    const holding = files.filter(file => readFileSync(file).includes('replyEffort'))
    check('no file the two runs left (the home, its transcript, the ledger, the daemon folder) holds the field', files.some(file => file.endsWith('.jsonl')) && holding.length === 0, j(holding))
    await built.close()
  }
}

check('no request left the machine', leftTheMachine.length === 0, j(leftTheMachine))
await api.close()
await refusing.close()
await families.close()
await new Promise<void>(resolve => proxy.close(() => resolve()))
console.log(`\n${failures === 0 ? 'HANDOFF LOW EFFORT: GREEN' : `HANDOFF LOW EFFORT: ${failures} FAILURE(S)`} (${checks} checks)`)
process.exit(failures === 0 ? 0 : 1)
