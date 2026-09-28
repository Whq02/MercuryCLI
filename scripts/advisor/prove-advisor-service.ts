#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_ADVISOR_MODEL', 'MERCURY_CONSOLE_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-service-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
type Raw = Record<string, unknown>

type FixtureMode = { kind: 'text'; text: string } | { kind: 'refuse'; status: number; message: string } | { kind: 'think'; tokens: number; text: string }
let fixture: FixtureMode = { kind: 'text', text: 'Verify the pin on the base before you cut.' }
const wire: Array<{ path: string; body: Raw }> = []
const FIXTURE_USAGE = { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 14 }
const VENDOR_OUTPUT_CAP = 128_000
const NOTE_TOKENS = 60
const sse = (name: string, obj: unknown): string => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
function anthropicText(text: string, model: string): string {
  return [
    sse('message_start', { type: 'message_start', message: { id: 'msg_advisor_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: FIXTURE_USAGE } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: FIXTURE_USAGE }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}
function anthropicThinkFirst(mode: { tokens: number; text: string }, maxTokens: number, model: string): string {
  const start = { input_tokens: 884, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const out: string[] = [
    sse('message_start', { type: 'message_start', message: { id: 'msg_advisor_think', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: start } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing the four decisions against each other before writing.' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]
  if (maxTokens < mode.tokens + NOTE_TOKENS) {
    out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: maxTokens, output_tokens_details: { thinking_tokens: maxTokens } } }))
    out.push(sse('message_stop', { type: 'message_stop' }))
    return out.join('')
  }
  out.push(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
  out.push(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: mode.text } }))
  out.push(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
  out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: mode.tokens + NOTE_TOKENS, output_tokens_details: { thinking_tokens: mode.tokens } } }))
  out.push(sse('message_stop', { type: 'message_stop' }))
  return out.join('')
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Raw = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Raw
    } catch {
      body = {}
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      wire.push({ path, body })
      if (fixture.kind === 'refuse') {
        res.writeHead(fixture.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: fixture.message } }))
        return
      }
      if (fixture.kind === 'think') {
        const maxTokens = Number(body.max_tokens)
        if (!Number.isFinite(maxTokens) || maxTokens > VENDOR_OUTPUT_CAP) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${String(body.max_tokens)} > ${VENDOR_OUTPUT_CAP}, which is the maximum allowed number of output tokens for ${String(body.model)}` } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(anthropicThinkFirst(fixture, maxTokens, String(body.model ?? 'fixture')))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicText(fixture.text, String(body.model ?? 'fixture')))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const address = server.address()
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

const { setIsInteractive } = await import(join(ROOT, 'src/bootstrap/state.ts'))
setIsInteractive(false)
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const state = await import(join(ROOT, 'src/bootstrap/state.ts'))
const config = await import(join(ROOT, 'src/utils/config.ts'))
const advisor = await import(join(ROOT, 'src/services/advisor/index.ts'))
const slots = await import(join(ROOT, 'src/utils/model/subModelSlots.ts'))
const workload = await import(join(ROOT, 'src/utils/workloadContext.ts'))
const rows = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
const text = await import(join(ROOT, 'src/utils/messages/text.ts'))
const { createUserMessage, createAssistantMessage } = await import(join(ROOT, 'src/utils/messages/factories.ts'))
const { getTranscriptPath } = await import(join(ROOT, 'src/utils/sessionStorage/paths.ts'))
const { calculateTokenWarningState, getEffectiveContextWindowSize } = await import(join(ROOT, 'src/services/compact/autoCompact.ts'))
const { getMaxOutputTokensForModel } = await import(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'))
const { modelThinkingAlwaysOn } = await import(join(ROOT, 'src/utils/model/capabilities.ts'))

const ADVISOR_MODEL = 'claude-opus-4-8'
const AGENT = 'agent-fixture-1'
const DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-context-'))
const ON5 = { enabled: true, seats: 5 }

type CallRecord = { model: string; system: string; prompt: string; effort?: string }
const makeCall = (answers: string[] | ((n: number) => string)): { call: (args: CallRecord) => Promise<Raw>; calls: CallRecord[] } => {
  const calls: CallRecord[] = []
  return {
    calls,
    call: async (args: CallRecord): Promise<Raw> => {
      calls.push(args)
      const answer = typeof answers === 'function' ? answers(calls.length) : (answers[calls.length - 1] ?? answers[answers.length - 1] ?? 'carry on')
      return { ok: true, text: answer }
    },
  }
}
const uuidAt = (n: number): string => `a5b6c7d8-0000-4000-8000-${String(n).padStart(12, '0')}`
const operatorRow = (n: number, words: string): Raw => createUserMessage({ content: words, uuid: uuidAt(n) as never }) as unknown as Raw
const replyRow = (n: number, words: string): Raw => ({ ...(createAssistantMessage({ content: words }) as unknown as Raw), uuid: uuidAt(n) })
const toolRow = (n: number, name: string, input: Raw): Raw => ({
  ...(createAssistantMessage({ content: [{ type: 'tool_use', id: `tu_${n}`, name, input }] as never }) as unknown as Raw),
  uuid: uuidAt(n),
})
const resultRow = (n: number, id: string, out: string, isError = false): Raw =>
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: out, ...(isError ? { is_error: true } : {}) }] as never, uuid: uuidAt(n) as never }) as unknown as Raw
const metaRow = (n: number, words: string): Raw => createUserMessage({ content: words, isMeta: true, uuid: uuidAt(n) as never }) as unknown as Raw

section('§0 the settings: off by default, ten turns, a trim-to-defaults writer beside the JEV row, the model through the /submodels store')
{
  const fresh = advisor.readAdvisorSettings()
  check('off by default, every 10 turns', fresh.enabled === false && fresh.seats === 10 && advisor.ADVISOR_DEFAULT_SEATS === 10, j(fresh))
  check('nothing stored for the defaults', config.getGlobalConfig().advisor === undefined)
  const on = advisor.setAdvisorEnabled(true)
  check('advisor:on lands as the one key', on.enabled && j(config.getGlobalConfig().advisor) === j({ enabled: true }), j(config.getGlobalConfig().advisor))
  const twenty = advisor.setAdvisorSeats(20)
  check('advisorseats:20 lands beside it', twenty.seats === 20 && j(config.getGlobalConfig().advisor) === j({ enabled: true, seats: 20 }), j(config.getGlobalConfig().advisor))
  const ten = advisor.setAdvisorSeats(10)
  check('the default interval trims back out of the file', ten.seats === 10 && j(config.getGlobalConfig().advisor) === j({ enabled: true }), j(config.getGlobalConfig().advisor))
  let refused = ''
  try {
    advisor.setAdvisorSeats(0)
  } catch (error) {
    refused = String(error)
  }
  check('the floor is one turn: 0 is refused typed, the file untouched', refused.includes('1 or more') && j(config.getGlobalConfig().advisor) === j({ enabled: true }), refused)
  check('a hand-edited off-floor interval reads as the default', advisor.advisorSettingsFromStored({ enabled: true, seats: 0 }).seats === 10 && advisor.advisorSettingsFromStored({ seats: 2.5 }).seats === 10)
  const off = advisor.setAdvisorEnabled(false)
  check('advisor off again removes the block entirely', !off.enabled && config.getGlobalConfig().advisor === undefined, j(config.getGlobalConfig().advisor))
  check('the ladder the /config row cycles is 5 · 10 · 20 · 50', j(advisor.ADVISOR_SEATS_LADDER) === j([5, 10, 20, 50]))
  check("the advisor is a second sub-model container beside the console, with its own env pin", j(slots.SUB_MODEL_CONTAINERS) === j(['console', 'advisor']) && slots.subModelEnvVar('advisor') === 'MERCURY_ADVISOR_MODEL' && slots.subModelEnvVar('console') === 'MERCURY_CONSOLE_MODEL', j(slots.SUB_MODEL_CONTAINERS))
  check('unpinned, the advisor model is UNSET and answers the /submodels hint', advisor.resolveAdvisorModel().origin === 'unset')
  process.env.MERCURY_ADVISOR_MODEL = ` ${ADVISOR_MODEL}[1m] `
  const pinned = advisor.resolveAdvisorModel()
  check('the env pin reads the way resolveSubModel reads: canonical id, the var named, LOCKED for the picker', pinned.origin === 'env' && pinned.model === ADVISOR_MODEL && pinned.envVar === 'MERCURY_ADVISOR_MODEL' && pinned.route === 'anthropic', j(pinned))
  const write = slots.setSubModel('advisor', ADVISOR_MODEL)
  check('the picker refuses a write while the var pins it, naming the var', !write.ok && write.reason.includes('MERCURY_ADVISOR_MODEL'), j(write))
  delete process.env.MERCURY_ADVISOR_MODEL
  config.saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: ADVISOR_MODEL } }))
  const saved = advisor.resolveAdvisorModel()
  check('the saved /submodels pick is the second rung', saved.origin === 'saved' && saved.model === ADVISOR_MODEL, j(saved))
  const identity = slots.subModelIdentityLine('advisor', saved as never)
  check('the identity line names the advisor and the model, never the operator as its audience', identity.includes('the Advisor') && identity.includes(ADVISOR_MODEL) && identity.includes('never the operator'), identity)
  const consoleIdentity = slots.subModelIdentityLine('console', { origin: 'saved', model: ADVISOR_MODEL, route: 'anthropic' } as never)
  check("the console's identity line is untouched", consoleIdentity.includes('the Console, the side-question assistant'))
  check("the advisor's effort context says its calls run with thinking off; the console's stays the session's", j(slots.subModelEffortContext('advisor')) === j({ thinkingEnabled: false }) && j(slots.subModelEffortContext('console')) === j({}))
  check('the workload vocabulary carries the advisor beside cron', workload.WORKLOAD_ADVISOR === 'advisor' && workload.WORKLOAD_CRON === 'cron')
  check('the receipt words name the state and the model', advisor.advisorReceiptWords({ enabled: true, seats: 5 }).includes('every 5 turns') && advisor.advisorReceiptWords({ enabled: false, seats: 10 }).startsWith('Advisor off'))
}

section("§1 off by default: with advisor.enabled false nothing runs — no context, no call, no note")
{
  const { call, calls } = makeCall(['a note that must never be asked for'])
  let note: unknown = 'unset'
  for (let turn = 1; turn <= 12; turn++) {
    note = await advisor.advisorTurnSettled(AGENT, [operatorRow(1, 'hello')] as never, { call: call as never, dir: DIR })
  }
  check('twelve settled turns with the advisor off: no note and no call', note === null && calls.length === 0, `note=${j(note)} calls=${calls.length}`)
  check('no advisor context was opened', advisor.peekAdvisorContext(AGENT) === undefined)
  check('no file was written', !existsSync(advisor.advisorContextPath(AGENT, DIR)))
}

section('§2 THE CADENCE: the counter fires at exactly `seats` turns and not before; the digest carries only the new rows; the note lands with the advisor origin')
{
  advisor.resetAdvisorContextsForTests()
  const { call, calls } = makeCall(['Verify the pin on the base before you cut.', 'The second note.'])
  const transcript: Raw[] = []
  const notes: Array<{ turn: number; note: Raw }> = []
  let n = 0
  for (let turn = 1; turn <= 12; turn++) {
    transcript.push(operatorRow(++n, `operator line ${turn}`))
    transcript.push(replyRow(++n, `reply ${turn}`))
    const note = await advisor.advisorTurnSettled(AGENT, transcript as never, { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
    if (note !== null) notes.push({ turn, note: note as unknown as Raw })
    if (turn < 5) check(`turn ${turn}: no note yet, no call`, note === null && calls.length === 0, `note=${j(note)} calls=${calls.length}`)
  }
  check('notes at exactly turns 5 and 10 in twelve turns (red on the base: no advisor)', j(notes.map(x => x.turn)) === j([5, 10]) && calls.length === 2, j(notes.map(x => x.turn)))
  const first = calls[0]!
  check("the first digest carries the ten rows of turns 1–5, rendered as the transcript reads", first.prompt.includes('[operator] operator line 1') && first.prompt.includes('[agent] reply 5') && !first.prompt.includes('operator line 6'), first.prompt.slice(0, 400))
  check('the first call carries the fixed system prompt, addressed to the agent, never the operator', first.system === advisor.ADVISOR_SYSTEM_PROMPT && first.system.includes('never address the operator') && first.system.includes(`at most ${advisor.ADVISOR_NOTE_MAX_LINES} lines`))
  check('the first call has no earlier notes to show', first.prompt.includes('no earlier notes'))
  const second = calls[1]!
  check('the second digest carries ONLY the rows since the first note (turns 6–10), never turns 1–5 again', second.prompt.includes('[operator] operator line 6') && second.prompt.includes('[agent] reply 10') && !second.prompt.includes('operator line 5') && !second.prompt.includes('reply 1\n'), second.prompt.slice(0, 600))
  check("the second call shows the advisor its own first note as memory", second.prompt.includes('[your note') && second.prompt.includes('Verify the pin on the base before you cut.'), second.prompt.slice(0, 600))
  const note1 = notes[0]!.note
  const origin = note1.origin as Raw
  check("the note's words are the fixture's answer, clamped to the line cap", note1.text === 'Verify the pin on the base before you cut.', j(note1))
  check("the note's origin: { kind: 'advisor', model, seats, at } — a MessageOrigin member the guard admits", rows.isAdvisorOrigin(origin) && origin.kind === 'advisor' && origin.model === ADVISOR_MODEL && origin.seats === 5 && typeof origin.at === 'string' && !rows.isSaturnOrigin(origin), j(origin))
  check('the guard refuses the other origins and a bare kind', !rows.isAdvisorOrigin({ kind: 'advisor' }) && !rows.isAdvisorOrigin({ kind: 'saturn', fire: 'wake', firedAt: 'x' }) && !rows.isAdvisorOrigin(undefined))
  const command = advisor.advisorNoteQueueCommand(note1 as never, uuidAt(900))
  check("the queue command is the Saturn door's shape: a prompt at later, slash-safe, the origin on it, never isMeta, no workload on the agent's turn", command.mode === 'prompt' && command.priority === 'later' && command.skipSlashCommands === true && command.isMeta === undefined && command.workload === undefined && j(command.origin) === j(origin) && command.value === note1.text, j(command))
  const context = advisor.peekAdvisorContext(AGENT)!
  check('the advisor context holds digest+note pairs for both notes, with the cursor on the last row shown', context.rows.map(r => r.kind).join(',') === 'digest,note,digest,note' && context.cursor === uuidAt(20), j({ kinds: context.rows.map(r => r.kind), cursor: context.cursor }))
  const mid = text.wrapCommandText(note1.text, origin as never)
  check("a mid-turn drain frames the note as advice from the advisor, never as 'the operator sent a new message'", mid.startsWith(text.ADVISOR_NOTE_HEAD) && mid.includes(note1.text) && mid.endsWith(text.ADVISOR_NOTE_TAIL) && !mid.includes('The operator sent a new message'), mid.slice(0, 200))
  check("the head says it is not the operator; the tail says it is advice, never an instruction", text.ADVISOR_NOTE_HEAD.includes('not the operator') && text.ADVISOR_NOTE_TAIL.includes('advice, not an instruction'))
  const human = text.wrapCommandText('x', undefined)
  check("the operator's own mid-turn framing is untouched", human.startsWith('The operator sent a new message while you were working:'))
}

section('§2b the digest: tool calls with their results clipped, meta rows and advisor rows skipped, the cursor advancing past every row')
{
  const long = 'x'.repeat(2000)
  const messages = [
    operatorRow(1, 'read the file'),
    toolRow(2, 'Read', { file_path: '/tmp/a.ts' }),
    resultRow(3, 'tu_2', long),
    resultRow(4, 'tu_2', 'boom', true),
    metaRow(5, 'a hidden system nudge'),
    { ...operatorRow(6, 'an earlier advisor note'), origin: { kind: 'advisor', model: 'm', seats: 5, at: 'now' } },
    replyRow(7, 'done'),
  ]
  const digest = advisor.renderAgentDigest(messages as never, undefined)
  const lines = digest.text.split('\n')
  check('one line per row kind: operator · tool · result · result error · agent', lines.length === 5 && lines[0]!.startsWith('[operator] read the file') && lines[1]!.startsWith('[tool] Read {"file_path":"/tmp/a.ts"}') && lines[2]!.startsWith('[result] xxxx') && lines[3]!.startsWith('[result error] boom') && lines[4] === '[agent] done', j(lines.map(l => l.slice(0, 40))))
  check(`a result is clipped to ${advisor.DIGEST_RESULT_CLIP} characters with an ellipsis`, lines[2]!.length === '[result] '.length + advisor.DIGEST_RESULT_CLIP + 1 && lines[2]!.endsWith('…'), String(lines[2]!.length))
  check('the meta row and the advisor row are not in the digest', !digest.text.includes('hidden system nudge') && !digest.text.includes('earlier advisor note'))
  check('the cursor is the last row, the digest counts the rows that spoke', digest.cursor === uuidAt(7) && digest.count === 5, j({ cursor: digest.cursor, count: digest.count }))
  const since = advisor.renderAgentDigest(messages as never, uuidAt(3))
  check('a digest since a cursor carries only the rows after it', since.text === '[result error] boom\n[agent] done' && since.count === 2, since.text)
  const none = advisor.renderAgentDigest(messages as never, uuidAt(7))
  check('nothing new ⇒ an empty digest, count 0, the cursor kept', none.count === 0 && none.text === '' && none.cursor === uuidAt(7))
  const gone = advisor.renderAgentDigest(messages as never, 'no-such-uuid')
  check('a cursor the list no longer holds (a compacted agent) reads the whole list again', gone.count === 5)
}

section('§3 the memory on disk: beside the transcript under <session>/advisor/<agentId>.jsonl; a fresh load reads the rows and the cursor back')
{
  const path = advisor.advisorContextPath(AGENT)
  const transcript = getTranscriptPath()
  check('the path law: the session dir beside the transcript, then advisor/, then the agent id', path === join(dirname(transcript), String(state.getSessionId()), 'advisor', `${AGENT}.jsonl`) && path.startsWith(process.env.MERCURY_CONFIG_DIR!), path)
  const file = advisor.advisorContextPath(AGENT, DIR)
  check('the fixture dir file exists after the notes', existsSync(file), file)
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
  check('one head line, then one line per row, JSON each', lines.length === 5 && (JSON.parse(lines[0]!) as Raw).kind === 'head' && lines.slice(1).every(l => typeof (JSON.parse(l) as Raw).text === 'string'), j(lines.map(l => (JSON.parse(l) as Raw).kind)))
  advisor.resetAdvisorContextsForTests()
  const resumed = await advisor.loadAdvisorContext(AGENT, { dir: DIR })
  check('a fresh process reads the four rows back with the cursor on the last row shown', resumed.rows.length === 4 && resumed.cursor === uuidAt(20) && resumed.rows[3]!.text === 'The second note.', j({ rows: resumed.rows.length, cursor: resumed.cursor }))
  check('the counter starts again after a resume (the memory carries, the cadence restarts)', resumed.turns === 0)
  const { call, calls } = makeCall(['note after resume'])
  const more = [operatorRow(21, 'after the resume'), replyRow(22, 'ok')]
  for (let turn = 1; turn <= 5; turn++) await advisor.advisorTurnSettled(AGENT, more as never, { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('after the resume the advisor remembers its earlier notes and reads only the rows after its cursor', calls.length === 1 && calls[0]!.prompt.includes('The second note.') && calls[0]!.prompt.includes('[operator] after the resume') && !calls[0]!.prompt.includes('operator line 1'), calls[0]?.prompt.slice(0, 500))
}

section('§4 TWO CLOCKS: the advisor context compacts on ITS gauge (the advisor model\'s window), never the agent\'s — agent 8k, advisor 64k')
{
  advisor.resetAdvisorContextsForTests()
  const context = await advisor.loadAdvisorContext('agent-fold', { dir: DIR })
  const big = 'row '.repeat(3000)
  for (let i = 0; i < 4; i++) {
    await advisor.appendAdvisorRow(context, { kind: 'digest', at: `t${i}`, text: big, cursor: uuidAt(100 + i) })
    await advisor.appendAdvisorRow(context, { kind: 'note', at: `t${i}`, text: `note ${i}` })
  }
  const tokens = advisor.advisorGaugeTokens(context)
  check('the gauge reads about 12k tokens of memory', tokens > 11_000 && tokens < 13_500, String(tokens))
  check('at an 8k window the fold would fire; at 64k it does not — the same rows, two windows, two verdicts', advisor.advisorShouldFold(tokens, 8_000) && !advisor.advisorShouldFold(tokens, 64_000), j({ tokens, at8k: advisor.advisorFoldThreshold(8_000), at64k: advisor.advisorFoldThreshold(64_000) }))
  check('the fold threshold keeps the reserve for the digest and the note, never below half the window', advisor.advisorFoldThreshold(64_000) === 44_000 && advisor.advisorFoldThreshold(8_000) === 4_000 && advisor.advisorFoldThreshold(200_000) === 180_000)
  const agentLevel = calculateTokenWarningState(tokens, ADVISOR_MODEL).level
  check("the agent's own clock is the main compaction law, untouched: 12k tokens on a 200k model is 'ok'", agentLevel === 'ok', agentLevel)
  const summaries: Array<{ systemPrompt: string; transcript: string; modelId: string }> = []
  const summarize = async (args: { systemPrompt: string; transcript: string; modelId: string }): Promise<string> => {
    summaries.push(args)
    return 'the summary of the older memory'
  }
  const keptAt64k = await advisor.maybeCompactAdvisorContext(context, { model: 'fixture-advisor', window: 64_000, summarize })
  check('on the 64k advisor gauge the advisor keeps every row — no summarizer call', keptAt64k.compacted === 0 && context.rows.length === 8 && summaries.length === 0 && keptAt64k.window === 64_000, j(keptAt64k))
  const foldedAt8k = await advisor.maybeCompactAdvisorContext(context, { model: 'fixture-advisor', window: 8_000, summarize })
  check('on an 8k gauge the fold fires: the two oldest rows fold into one summary, the newest six stay verbatim', foldedAt8k.compacted === 2 && context.rows.length === 7 && context.rows[0]!.kind === 'summary' && context.rows[0]!.text === 'the summary of the older memory' && context.rows[0]!.folded === 2 && context.rows[6]!.text === 'note 3', j({ ...foldedAt8k, kinds: context.rows.map(r => r.kind) }))
  check("the summarizer was handed the advisor's own fold prompt, the model, and the folded rows only", summaries.length === 1 && summaries[0]!.systemPrompt === advisor.advisorCompactSummaryPrompt() && summaries[0]!.modelId === 'fixture-advisor' && summaries[0]!.transcript.includes('[your note to the agent] note 0') && !summaries[0]!.transcript.includes('note 1'), summaries[0]?.transcript.slice(-200))
  check('the fold prompt is about an advisor\'s memory, three sections, no invention', advisor.advisorCompactSummaryPrompt().includes("advisor's own memory") && advisor.advisorCompactSummaryPrompt().includes('Advice given'))
  const lines = readFileSync(advisor.advisorContextPath('agent-fold', DIR), 'utf8').split('\n').filter(l => l.trim() !== '')
  check('the fold APPENDS its summary row — the file stays append-only like the transcript (no whole-file rewrite route): head + the eight rows + the summary last', lines.length === 10 && (JSON.parse(lines[9]!) as Raw).kind === 'summary' && (JSON.parse(lines[9]!) as Raw).folded === 2, j(lines.map(l => (JSON.parse(l) as Raw).kind)))
  const readBack = advisor.parseAdvisorContextLines('agent-fold', readFileSync(advisor.advisorContextPath('agent-fold', DIR), 'utf8'))
  check('a fresh read applies the fold: the summary stands first for the two oldest rows, the six kept rows follow verbatim', readBack.length === 7 && readBack[0]!.kind === 'summary' && readBack[0]!.folded === 2 && readBack[1]!.text === context.rows[1]!.text && readBack[6]!.text === 'note 3', j(readBack.map(r => r.kind)))
  check('the cursor survives the fold on the kept rows', context.cursor === uuidAt(103))
  const small = getEffectiveContextWindowSize(ADVISOR_MODEL)
  const large = getEffectiveContextWindowSize(`${ADVISOR_MODEL}[1m]`)
  const gauge = await advisor.advisorWindowOf(`${ADVISOR_MODEL}[1m]`)
  check("the live gauge is the ADVISOR model's effective window: a 1M advisor over a 200k agent keeps the longer memory", gauge === large && large > small && small > 100_000, j({ small, large, gauge }))
  const refusing = async (): Promise<string> => {
    throw new Error('the summary road is down')
  }
  const before = context.rows.length
  const refused = await advisor.maybeCompactAdvisorContext(context, { model: 'fixture-advisor', window: 2_000, summarize: refusing })
  check('a refused fold leaves the rows untouched and says why', refused.compacted === 0 && typeof refused.refused === 'string' && refused.refused.includes('the summary road is down') && context.rows.length === before, j(refused))
}

section('§5 THE ASK ROAD: the agent\'s question plus the digest since the last note → one reply, recorded like a note')
{
  advisor.resetAdvisorContextsForTests()
  const { call, calls } = makeCall(['Check the base first: run the pin on 89017923b before you edit.'])
  const transcript = [operatorRow(1, 'fix the flaky pin'), replyRow(2, 'I will start with the seam')]
  const off = await advisor.askAdvisor('agent-ask', 'am I on the right seam?', transcript as never, { call: call as never, settings: { enabled: false, seats: 10 }, model: ADVISOR_MODEL, dir: DIR })
  check('with the advisor off the ask answers a typed refusal and spends nothing', !off.ok && off.reason.includes('off') && calls.length === 0, j(off))
  const empty = await advisor.askAdvisor('agent-ask', '   ', transcript as never, { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('an empty question is refused typed', !empty.ok && empty.reason.includes('empty'))
  const asked = await advisor.askAdvisor('agent-ask', 'am I on the right seam?', transcript as never, { call: call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check("the reply is the fixture's answer, with the model named", asked.ok && asked.reply === 'Check the base first: run the pin on 89017923b before you edit.' && asked.model === ADVISOR_MODEL, j(asked))
  const prompt = calls[0]!.prompt
  check('the prompt carries the digest since the last note and the question, under the same system prompt', prompt.includes('[operator] fix the flaky pin') && prompt.includes('<the_agents_question>\nam I on the right seam?') && calls[0]!.system === advisor.ADVISOR_SYSTEM_PROMPT && prompt.includes(advisor.ADVISOR_ASK_PROMPT_TAIL), prompt.slice(0, 400))
  const context = advisor.peekAdvisorContext('agent-ask')!
  check('the ask is recorded in the advisor context like a note: digest · question · reply, the cursor advanced', context.rows.map(r => r.kind).join(',') === 'digest,question,reply' && context.cursor === uuidAt(2), j(context.rows.map(r => r.kind)))
  const { call: call2, calls: calls2 } = makeCall(['note after the ask'])
  for (let turn = 1; turn <= 5; turn++) await advisor.advisorTurnSettled('agent-ask', transcript as never, { call: call2 as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('the next scheduled note sees nothing new after the ask consumed the rows (no call) — the ask and the cadence share one cursor', calls2.length === 0)
  transcript.push(replyRow(3, 'after the ask'))
  for (let turn = 1; turn <= 5; turn++) await advisor.advisorTurnSettled('agent-ask', transcript as never, { call: call2 as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('and the next note after new rows remembers the question and the reply', calls2.length === 1 && calls2[0]!.prompt.includes('[the agent asked') && calls2[0]!.prompt.includes('[your reply') && calls2[0]!.prompt.includes('[agent] after the ask'), calls2[0]?.prompt.slice(0, 500))
}

section("§6 THE LIVE CALL through the one routing seam: the workload bucket carries the advisor's tokens; a refused model is silent")
{
  state.resetCostState()
  wire.length = 0
  fixture = { kind: 'text', text: 'Line one.\nLine two.' }
  const reply = await advisor.liveAdvisorCall({ model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' })
  check('the live call answers the fixture\'s text', reply.ok && reply.text === 'Line one.\nLine two.', j(reply))
  check('one request left through the loopback fixture, no tools, the model named, the digest as the one user row', wire.length === 1 && wire[0]!.body.model === ADVISOR_MODEL && j((wire[0]!.body.tools as unknown[] | undefined) ?? []) === '[]' && j(wire[0]!.body.messages).includes('the digest'), j(wire[0]?.body).slice(0, 300))
  check("the request's system prompt is the advisor's, its output ceiling the model's own (the main loop's law, never a smaller cap of the advisor's)", j(wire[0]!.body.system).includes('sys') && wire[0]!.body.max_tokens === getMaxOutputTokensForModel(ADVISOR_MODEL) && wire[0]!.body.max_tokens === 128_000, j({ system: wire[0]?.body.system, max: wire[0]?.body.max_tokens, ceiling: getMaxOutputTokensForModel(ADVISOR_MODEL) }))
  const bucket = state.getWorkloadUsage() as Record<string, Record<string, Raw>>
  const row = bucket.advisor?.[ADVISOR_MODEL]
  check("the advisor bucket carries the call's tokens (red on the base: no advisor workload) — 90 in · 14 out", row !== undefined && row.inputTokens === 90 && row.outputTokens === 14, j(bucket))
  check('the per-model ledger carries the same turn, and no other bucket exists', (state.getModelUsage() as Record<string, Raw>)[ADVISOR_MODEL]?.inputTokens === 90 && Object.keys(bucket).length === 1, j(Object.keys(bucket)))
  fixture = { kind: 'refuse', status: 401, message: 'no such key for this seat' }
  const refused = await advisor.liveAdvisorCall({ model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' })
  check('a refused advisor model answers ok:false with the reason, never a throw', !refused.ok && refused.reason.length > 0, j(refused))
  advisor.resetAdvisorContextsForTests()
  const transcript = [operatorRow(1, 'hello'), replyRow(2, 'hi')]
  let note: unknown = 'unset'
  for (let turn = 1; turn <= 5; turn++) note = await advisor.advisorTurnSettled('agent-refused', transcript as never, { settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('on the cadence a refused advisor is silent: no note, nothing in the agent\'s context', note === null)
  const context = advisor.peekAdvisorContext('agent-refused')!
  check('and nothing is recorded in its memory for the refused round', context.rows.length === 0)
  fixture = { kind: 'text', text: 'carry on' }
  for (let turn = 1; turn <= 5; turn++) note = await advisor.advisorTurnSettled('agent-refused', transcript as never, { settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check("an advisor that answers 'carry on' lands no row in the agent's context, but its memory records the look", note === null && context.rows.map(r => r.kind).join(',') === 'digest,note', j(context.rows.map(r => r.kind)))
  advisor.resetAdvisorContextsForTests()
  config.saveGlobalConfig(c => {
    const next = { ...c.subModels }
    delete next.advisor
    return { ...c, subModels: Object.keys(next).length > 0 ? next : undefined }
  })
  const unset = advisor.setAdvisorEnabled(true)
  let unsetNote: unknown = 'unset'
  const { call, calls } = makeCall(['never'])
  for (let turn = 1; turn <= 10; turn++) unsetNote = await advisor.advisorTurnSettled('agent-unset', transcript as never, { call: call as never, dir: DIR })
  check('advisor on but no model pinned: silent with a debug line, no call (the choice is the operator\'s)', unset.enabled && unsetNote === null && calls.length === 0)
  advisor.setAdvisorEnabled(false)
}

section('§7 THE CALL HAS ROOM TO ANSWER: an always-thinking advisor that thinks past the old 1,200-token cap before it writes still lands its words (red on the base: the thinking ate the budget and the note read as no text)')
{
  const THINK = 4000
  const NOTE = 'The two most dangerous: (A) plain-text passwords, one leak exposes every account; (B) the peak-hours migration with no dry run, no way back if it fails.'
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
    state.resetCostState()
    wire.length = 0
    fixture = { kind: 'think', tokens: THINK, text: NOTE }
    const reply = await advisor.liveAdvisorCall({ model, system: 'sys', prompt: 'the four decisions', effort: 'max' })
    const body = wire[0]?.body ?? {}
    check(`${model}: the words come back whole after ${THINK} thinking tokens (red on the base: "the advisor answered with no text")`, reply.ok && reply.text === NOTE, j(reply))
    check(`${model}: thinking is always on for this model, so the request carries no thinking key at all (the vendor answers 400 to the disabled shape)`, modelThinkingAlwaysOn(model) && !('thinking' in body), j({ thinking: body.thinking, keys: Object.keys(body) }))
    check(`${model}: max_tokens is the model's own output ceiling, the main loop's law (red on the base: 1200)`, body.max_tokens === getMaxOutputTokensForModel(model) && body.max_tokens === 128_000, j({ max: body.max_tokens, ceiling: getMaxOutputTokensForModel(model) }))
    check(`${model}: the effort dial rides as given, never lowered to make room`, j(body.output_config) === j({ effort: 'max' }), j(body.output_config))
    const bucket = state.getWorkloadUsage() as Record<string, Record<string, Raw>>
    check(`${model}: the advisor bucket carries the thinking spend — ${THINK + NOTE_TOKENS} output tokens`, bucket.advisor?.[model]?.outputTokens === THINK + NOTE_TOKENS, j(bucket.advisor?.[model]))
  }
  advisor.resetAdvisorContextsForTests()
  config.saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: 'claude-opus-5-5' } }))
  advisor.setAdvisorEnabled(true)
  advisor.setAdvisorSeats(5)
  const dial = slots.setSubModelEffort('advisor', 'max')
  check("the operator's dial: the advisor container's effort set to max on claude-opus-5-5", dial.ok && advisor.advisorDispatchEffort('claude-opus-5-5') === 'max', j(dial))
  wire.length = 0
  fixture = { kind: 'think', tokens: THINK, text: NOTE }
  const transcript = [operatorRow(1, 'four decisions for the release'), replyRow(2, 'which two are the most dangerous?')]
  let note: unknown = 'unset'
  for (let turn = 1; turn <= 5; turn++) note = await advisor.advisorTurnSettled('agent-dial', transcript as never, { dir: DIR })
  const landed = note as Raw | null
  check("the operator's own condition — the saved model, the saved dial, the real call — lands the note on the fifth turn (red on the base: null)", landed !== null && landed.text === NOTE && (landed.origin as Raw).model === 'claude-opus-5-5', j(note))
  check('that request carried output_config.effort max and the 128,000 ceiling, no thinking key', wire.length === 1 && j(wire[0]!.body.output_config) === j({ effort: 'max' }) && wire[0]!.body.max_tokens === 128_000 && !('thinking' in wire[0]!.body), j({ output_config: wire[0]?.body.output_config, max: wire[0]?.body.max_tokens }))
  const callSource = readFileSync(join(ROOT, 'src/services/advisor/advisorCall.ts'), 'utf8')
  check('by source: the advisor call carries no wall clock of its own (a thinking model is never cut) and no output cap of its own', !callSource.includes('AbortSignal.timeout(') && !callSource.includes('maxOutputTokensOverride'), callSource.split('\n').filter(l => l.includes('AbortSignal.timeout(') || l.includes('maxOutputTokensOverride')).join(' | '))
  slots.setSubModelEffort('advisor', null)
  advisor.setAdvisorEnabled(false)
  config.saveGlobalConfig(c => {
    const next = { ...c.subModels }
    delete next.advisor
    return { ...c, subModels: Object.keys(next).length > 0 ? next : undefined }
  })
}

section('§8 ONCE MORE ON AN EMPTY ANSWER, THEN A QUIET ROW: an empty answer is asked once more; still empty, the round hands the chat a muted row instead of silence; a refusal is never asked twice (red on the base: one call, no note, no row)')
{
  const transcript = [operatorRow(1, 'four decisions for the release'), replyRow(2, 'which two are the most dangerous?')]
  const quiets: Raw[] = []
  const onQuiet = (quiet: unknown): void => {
    quiets.push(quiet as Raw)
  }
  advisor.resetAdvisorContextsForTests()
  const once = makeCall(['', 'The real note, on the second ask.'])
  let note: unknown = 'unset'
  for (let turn = 1; turn <= 5; turn++) note = await advisor.advisorTurnSettled('agent-once-more', transcript as never, { call: once.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, onQuiet })
  check('an empty answer is asked once more and the second answer lands as the note — exactly two calls, no quiet row (red on the base: one call, an empty note)', (note as Raw | null)?.text === 'The real note, on the second ask.' && once.calls.length === 2 && quiets.length === 0, j({ note, calls: once.calls.length, quiets: quiets.length }))
  check('the second ask carries the same prompt as the first', once.calls.length === 2 && once.calls[0]!.prompt === once.calls[1]!.prompt)
  advisor.resetAdvisorContextsForTests()
  const twice = makeCall(['', '', 'never a third answer'])
  note = 'unset'
  for (let turn = 1; turn <= 5; turn++) note = await advisor.advisorTurnSettled('agent-twice', transcript as never, { call: twice.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR, onQuiet })
  check('empty twice: exactly two calls, never a third, and no note (red on the base: one call)', note === null && twice.calls.length === 2, j({ note, calls: twice.calls.length }))
  const quiet = quiets[0]
  check("and the round hands the chat ONE quiet verdict with the advisor origin, marked empty, whose words say the advisor had nothing to say (red on the base: nothing)", quiets.length === 1 && quiet !== undefined && rows.isAdvisorOrigin(quiet.origin) && (quiet.origin as Raw).model === ADVISOR_MODEL && (quiet.origin as Raw).seats === 5 && quiet.empty === true && quiet.reason === advisor.ADVISOR_EMPTY_TWICE_REASON && advisor.advisorQuietWords(quiet as never) === 'had nothing to say this round — answered with no text, twice', j(quiets))
  const twiceContext = advisor.peekAdvisorContext('agent-twice')!
  check("the advisor's memory records nothing for the quiet round and its cursor stays, so the next round reads the same rows again", twiceContext.rows.length === 0 && twiceContext.cursor === undefined, j({ rows: twiceContext.rows.length, cursor: twiceContext.cursor }))
  const minted = typeof advisor.createAdvisorQuietMessage === 'function'
  check('the service mints the quiet row and its words (red on the base: no such factory)', minted)
  const row = minted ? (advisor.createAdvisorQuietMessage(quiet as never) as unknown as Raw) : ({} as Raw)
  check("the quiet row is a system record of its own subtype with the origin and the words, info level, never meta — a row the transcript keeps and the model never sees", row.type === 'system' && row.subtype === 'advisor_quiet' && minted && advisor.isAdvisorQuietMessage(row) && j(row.origin) === j(quiet!.origin) && row.content === 'had nothing to say this round — answered with no text, twice' && row.level === 'info' && row.isMeta === false && typeof row.uuid === 'string' && typeof row.timestamp === 'string', j(row))
  const { normalizeMessagesForAPI } = await import(join(ROOT, 'src/utils/messages/apiView.ts'))
  const planned = normalizeMessagesForAPI([...transcript, ...(minted ? [row] : [])] as never)
  check('the API plan leaves the quiet row out: the agent never reads it', minted && planned.length === 2 && !j(planned).includes('had nothing to say'), j(planned.map((m: Raw) => m.type)))
  quiets.length = 0
  wire.length = 0
  fixture = { kind: 'refuse', status: 401, message: 'no such key for this seat' }
  advisor.resetAdvisorContextsForTests()
  for (let turn = 1; turn <= 5; turn++) note = await advisor.advisorTurnSettled('agent-refused-quiet', transcript as never, { settings: ON5, model: ADVISOR_MODEL, dir: DIR, onQuiet })
  const refusalWords = minted && quiets.length === 1 ? advisor.advisorQuietWords(quiets[0] as never) : ''
  check('a refusal is asked once, never twice, and its quiet row carries the refusal words, not the empty words', note === null && wire.length === 1 && quiets.length === 1 && quiets[0]!.empty === false && refusalWords.startsWith('had nothing to say this round — ') && refusalWords.includes('no such key for this seat'), j({ wire: wire.length, quiets }))
  const long = minted ? advisor.advisorQuietWords({ origin: { kind: 'advisor', model: ADVISOR_MODEL, seats: 5, at: 'now' }, reason: 'x'.repeat(500), empty: false } as never) : ''
  check(`a long reason is clipped to ${String(advisor.ADVISOR_QUIET_REASON_CLIP)} characters on the row`, minted && long.length === 'had nothing to say this round — '.length + advisor.ADVISOR_QUIET_REASON_CLIP + 1 && long.endsWith('…'), String(long.length))
  wire.length = 0
  fixture = { kind: 'think', tokens: 200_000, text: 'never reached' }
  const overrun = typeof advisor.callAdvisorOnceMore === 'function' ? await advisor.callAdvisorOnceMore(advisor.liveAdvisorCall, { model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' }) : await advisor.liveAdvisorCall({ model: ADVISOR_MODEL, system: 'sys', prompt: 'the digest' })
  check('through the live call, a thinking-only turn that stops on max_tokens reads as empty, is asked once more, and answers the twice words — two requests on the wire (red on the base: one request, the one-ask words)', !overrun.ok && overrun.empty === true && overrun.reason === advisor.ADVISOR_EMPTY_TWICE_REASON && wire.length === 2, j({ overrun, wire: wire.length }))
  advisor.resetAdvisorContextsForTests()
  const askOnce = makeCall(['', 'Check the base first.'])
  const asked = await advisor.askAdvisor('agent-ask-once-more', 'am I on the right seam?', transcript as never, { call: askOnce.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check('the ask road asks once more too: empty then words answers ok with two calls (red on the base: refused after one)', asked.ok && asked.reply === 'Check the base first.' && askOnce.calls.length === 2, j({ asked, calls: askOnce.calls.length }))
  const askTwice = makeCall(['', ''])
  const unanswered = await advisor.askAdvisor('agent-ask-twice', 'am I on the right seam?', transcript as never, { call: askTwice.call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check("empty twice on the ask road names it in the reason the tool result carries — the agent is told, never left in silence", !unanswered.ok && unanswered.reason === advisor.ADVISOR_EMPTY_TWICE_REASON && askTwice.calls.length === 2, j(unanswered))
  const crew = await advisor.advisorAgentRound('agent-crew-quiet', transcript as never, { call: makeCall(['', '']).call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check("a crewmate's round answers the quiet verdict as its own word, distinct from silent (nothing new) and from delivered", ['counted', 'quiet'].includes(crew), crew)
  let crewVerdict: string = crew
  for (let turn = 1; turn <= 4; turn++) crewVerdict = await advisor.advisorAgentRound('agent-crew-quiet', transcript as never, { call: makeCall(['', '']).call as never, settings: ON5, model: ADVISOR_MODEL, dir: DIR })
  check("on the fifth round the crewmate's road reads quiet and stashes no note", crewVerdict === 'quiet' && advisor.peekAdvisorNotes('agent-crew-quiet').length === 0, crewVerdict)
}

server.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} advisor service: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
