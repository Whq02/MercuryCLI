#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_ADVISOR_MODEL', 'MERCURY_CONSOLE_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-roads-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-roads-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-roads-teams-'))
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
const settle = (ms = 50): Promise<void> => new Promise(r => setTimeout(r, ms))
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — advisor roads prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

const AGENT_MODEL = 'claude-opus-4-8'
const ADVISOR_MODEL = 'claude-sonnet-4-5'
const AGENT_USAGE = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 6 }
const ADVISOR_USAGE = { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 14 }
type AgentTurn = { text: string } | { ask: string; then: string } | { echo: string; then?: string }
let agentScript: AgentTurn[] = []
let agentOrdinal = 0
let agentDelayMs = 0
let advisorNotes = 0
let advisorReplies = 0
const wire: Array<{ model: string; kind: 'agent' | 'advisor-note' | 'advisor-ask'; body: Raw }> = []
const sse = (name: string, obj: unknown): string => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
function textOf(body: Raw): string {
  return JSON.stringify(body.messages ?? '')
}
function anthropicReply(model: string, blocks: Array<{ text: string } | { toolUse: { id: string; name: string; input: Raw } }>, usage: Raw, stop: string): string {
  const out: string[] = [sse('message_start', { type: 'message_start', message: { id: `msg_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })]
  blocks.forEach((block, index) => {
    if ('text' in block) {
      out.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }))
    } else {
      out.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.toolUse.id, name: block.toolUse.name, input: {} } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.toolUse.input) } }))
    }
    out.push(sse('content_block_stop', { type: 'content_block_stop', index }))
  })
  out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }))
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
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const model = String(body.model ?? '')
    if (model === ADVISOR_MODEL) {
      const ask = textOf(body).includes('<the_agents_question>')
      wire.push({ model, kind: ask ? 'advisor-ask' : 'advisor-note', body })
      const text = ask ? `ADVISOR-ASK-REPLY-${++advisorReplies}: run the pin on the base first.` : `ADVISOR-NOTE-${++advisorNotes}: you have not checked the base yet.\nDo that before the next edit.`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicReply(model, [{ text }], ADVISOR_USAGE, 'end_turn'))
      return
    }
    wire.push({ model, kind: 'agent', body })
    const turn = agentScript[agentOrdinal] ?? { text: 'script exhausted' }
    agentOrdinal++
    const answer = (): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if ('ask' in turn) res.end(anthropicReply(model, [{ toolUse: { id: `tu_ask_${agentOrdinal}`, name: 'AskAdvisor', input: { question: turn.ask } } }], AGENT_USAGE, 'tool_use'))
      else if ('echo' in turn) res.end(anthropicReply(model, [{ toolUse: { id: `tu_echo_${agentOrdinal}`, name: 'EchoTool', input: { text: turn.echo } } }], AGENT_USAGE, 'tool_use'))
      else res.end(anthropicReply(model, [{ text: turn.text }], AGENT_USAGE, 'end_turn'))
    }
    if (agentDelayMs > 0) setTimeout(answer, agentDelayMs)
    else answer()
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
const rows = await import(join(ROOT, 'src/utils/messages/noticeRows.ts'))
const text = await import(join(ROOT, 'src/utils/messages/text.ts'))
const { query } = await import(join(ROOT, 'src/query.ts'))
const { productionDeps } = await import(join(ROOT, 'src/query/deps.ts'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { createUserMessage } = await import(join(ROOT, 'src/utils/messages.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(ROOT, 'src/utils/fileStateCache.ts'))
const queue = await import(join(ROOT, 'src/input-core/command-queue.ts'))
const { AskAdvisorTool, askAdvisorAgentId } = await import(join(ROOT, 'src/tools/AskAdvisorTool/AskAdvisorTool.ts'))
const { ASK_ADVISOR_TOOL_NAME } = await import(join(ROOT, 'src/tools/AskAdvisorTool/constants.ts'))
const toolsConstants = await import(join(ROOT, 'src/constants/tools.ts'))
const { runAgent } = await import(join(ROOT, 'src/tools/AgentTool/runAgent.ts'))
const { getAgentTranscriptPath } = await import(join(ROOT, 'src/utils/sessionStorage/paths.ts'))
const { flushSessionStorage } = await import(join(ROOT, 'src/utils/sessionStorage/writer.ts'))
const { recordToEntry } = await import(join(ROOT, 'src/fabric/entryCodec.ts'))
type AnyMsg = Record<string, unknown> & { type?: string }

const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const between = (body: string, from: string, to: string): string => {
  const at = body.indexOf(from)
  if (at < 0) return ''
  const end = body.indexOf(to, at)
  return end < 0 ? body.slice(at) : body.slice(at, end + to.length)
}

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return `${name} rig tool`
    },
    async prompt() {
      return `${name} rig tool`
    },
    inputSchema: z.object({ text: z.string() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: { text: string }) {
      return { data: `echo:${input.text}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const EchoTool = makeTool('EchoTool')
const TOOLS = [EchoTool, AskAdvisorTool]
const allowAll = (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never

function makeCtx(agentId?: string): Raw {
  let appState: Raw = { ...(getDefaultAppState() as unknown as Raw), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: TOOLS,
      mainLoopModel: AGENT_MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Raw
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId,
  }
}

const toolResultsOf = (yields: AnyMsg[]): Array<{ id: string; text: string }> => {
  const out: Array<{ id: string; text: string }> = []
  for (const m of yields) {
    if (m.type !== 'user') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as AnyMsg[]) {
      if (b.type !== 'tool_result') continue
      const raw = b.content
      out.push({ id: String(b.tool_use_id), text: typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(x => String((x as AnyMsg).text ?? '')).join('') : '' })
    }
  }
  return out
}

section('§0 the wiring: one call site per road, the drain, the framing, the tool gate and its enrolment (red on the base: none of it)')
{
  const runner = src('src/cli/print.ts')
  const settled = between(runner, 'onTurnSettled: command => {', 'hasWaitableBackgroundTasks')
  check("the main chat: the driver's onTurnSettled advances the advisor with the session's own message list and enqueues the note for the NEXT turn through the Saturn door, kicking the driver", settled.includes('advisorMainTurnSettled(String(getSessionId()), command, messages') && settled.includes('enqueue(advisorNoteQueueCommand(note, randomUUID()))') && settled.includes('driver.kick()') && settled.includes('if (inputClosed) return'), settled.slice(0, 400))
  const agent = src('src/tools/AgentTool/runAgent.ts')
  const boundary = between(agent, 'const pausableQuery = async function*', 'const next = await stream.next()')
  check("crewmates and workers: runAgent's request boundary advances the advisor with the agent's own rows after the pause seam, never inside it", boundary.includes('void advisorAgentRound(agentId, advisedRows)') && boundary.indexOf('beforeQueryStep()') < boundary.indexOf('advisorAgentRound'), boundary.slice(-300))
  const hooks = src('src/tools/WorkflowTool/agentHooks.ts')
  const spawn = between(hooks, 'async function* adapterSpawnStream(', 'yield* stream')
  check("workflow workers ride the same runAgent road with the pause seam passed through (the spawn adapter, unchanged)", spawn.includes('const stream = runAgent({') && spawn.includes('beforeQueryStep: args.beforeQueryStep'), spawn.slice(-200))
  const drain = src('src/utils/attachments/queuedCommands.ts')
  check("the pending-message drain hands the agent its stashed advisor notes as queued_command attachments with the advisor origin and no isMeta", drain.includes('takeAdvisorNotes(agentId).map(note => ({') && drain.includes('origin: note.origin,') && !between(drain, 'const advice', '}))').includes('isMeta'), between(drain, 'const advice', '}))'))
  const framing = src('src/utils/messages/attachmentText.ts')
  check('a drained advisor note is never a hidden meta row (the origin law excepts the advisor)', framing.includes('(origin !== undefined && !isAdvisorOrigin(origin)) || attachment.isMeta'))
  const painter = src('src/components/messages/AttachmentMessage.tsx')
  check('the attachment painter hands the advisor origin to the row painter, so the crewmate transcript shows the muted row', painter.includes('isAdvisorOrigin(attachment.origin) ? { origin: attachment.origin } : {}'))
  const catalogue = src('src/tools.ts')
  check('the tool is in the catalogue only while the advisor is on (the JevEval gate precedent)', catalogue.includes('...(advisorEnabled() ? [AskAdvisorTool] : []),'))
  check('the tool is enrolled for async agents and in-process teammates', toolsConstants.ASYNC_AGENT_ALLOWED_TOOLS.has(ASK_ADVISOR_TOOL_NAME) && toolsConstants.IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(ASK_ADVISOR_TOOL_NAME) && !toolsConstants.ALL_AGENT_DISALLOWED_TOOLS.has(ASK_ADVISOR_TOOL_NAME))
  const census = JSON.parse(src('scripts/builtin-tools/fixtures/tool-census.json')) as { rows: Array<{ name: string; proof?: string; declared?: { conditions?: string[] } }> }
  const row = census.rows.find(r => r.name === ASK_ADVISOR_TOOL_NAME)
  check('the census anchor rows the tool with its proof and its condition', row !== undefined && row.proof === 'scripts/advisor/run-all.sh' && (row.declared?.conditions ?? []).some(c => c.includes('Advisor on')), j(row))
  check("the tool's agent id is the session's on the main thread and the agent's for a crewmate", askAdvisorAgentId({ agentId: undefined }) === String(state.getSessionId()) && askAdvisorAgentId({ agentId: 'agent-x' as never }) === 'agent-x')
  check("the tool's input is one question", AskAdvisorTool.inputSchema.safeParse({ question: 'x' }).success && !AskAdvisorTool.inputSchema.safeParse({}).success && !AskAdvisorTool.inputSchema.safeParse({ question: 'x', extra: 1 }).success)
}

const SESSION = String(state.getSessionId())
const advisorOn = (seats: number): void => {
  advisor.setAdvisorEnabled(true)
  advisor.setAdvisorSeats(seats)
  config.saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: ADVISOR_MODEL } }))
}
const resetRig = (): void => {
  wire.length = 0
  agentOrdinal = 0
  advisorNotes = 0
  advisorReplies = 0
  advisor.resetAdvisorContextsForTests()
  advisor.resetAdvisorRoadsForTests()
  queue.resetCommandQueue()
  state.resetCostState()
}

async function mainTurn(prompt: string, origin: Raw | undefined, messages: AnyMsg[]): Promise<AnyMsg[]> {
  const ctx = makeCtx()
  const deps = productionDeps()
  const userRow = createUserMessage({ content: prompt, ...(origin !== undefined ? { origin: origin as never } : {}) }) as unknown as AnyMsg
  messages.push(userRow)
  ;(ctx as { messages: unknown }).messages = messages
  const yields: AnyMsg[] = []
  const gen = query({
    messages: messages as never,
    systemPrompt: ['fixture system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: { callModel: deps.callModel, autocompact: (async () => ({ wasCompacted: false })) as never, microcompact: (async (m: unknown[]) => ({ messages: m })) as never, uuid: deps.uuid },
  })
  let r = await gen.next()
  while (!r.done) {
    const m = r.value as AnyMsg
    yields.push(m)
    if (m.type === 'assistant' || m.type === 'user') messages.push(m)
    r = await gen.next()
  }
  return yields
}

section('§1 THE MAIN CHAT: twelve operator turns with seats 5 — two notes land as advisor rows after turns 5 and 10, the agent\'s AskAdvisor call returns the fixture\'s reply, the advisor bucket carries its tokens')
{
  resetRig()
  advisorOn(5)
  agentScript = Array.from({ length: 20 }, (_, i) => (i === 2 ? { ask: 'am I on the right seam?', then: 'reply 3' } : { text: `reply ${i + 1}` }))
  const messages: AnyMsg[] = []
  const commands: string[] = []
  const rowsAfterTurn: number[] = []
  let askResult = ''
  let askedTools: string[] = []
  for (let turn = 1; turn <= 12; turn++) {
    const queued = queue.dequeue() as Raw | undefined
    if (queued !== undefined) {
      commands.push(`advisor@${turn}`)
      await mainTurn(String(queued.value), queued.origin as Raw, messages)
      await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt', origin: queued.origin } as never, messages as never, () => {
        throw new Error('the advisor never answers its own note turn')
      })
    }
    commands.push(`operator@${turn}`)
    const yields = await mainTurn(`operator line ${turn}`, undefined, messages)
    if (turn === 3) {
      askedTools = yields.filter(m => m.type === 'assistant').flatMap(m => ((m.message as Raw).content as AnyMsg[]).filter(b => b.type === 'tool_use').map(b => String(b.name)))
      askResult = toolResultsOf(yields).find(t => t.id.startsWith('tu_ask'))?.text ?? ''
    }
    await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never, note => {
      queue.enqueue(advisor.advisorNoteQueueCommand(note, crypto.randomUUID()) as never)
    })
    rowsAfterTurn.push(messages.filter(m => m.type === 'user' && rows.isAdvisorOrigin(m.origin)).length)
  }
  check('the turns ran in order with the two advisor turns taken before operator turns 6 and 11', j(commands.filter(c => c.startsWith('advisor'))) === j(['advisor@6', 'advisor@11']), j(commands))
  check('advisor rows in the transcript: none through turn 5, one after turn 6, two after turn 11 (red on the base: never any)', j(rowsAfterTurn) === j([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2]), j(rowsAfterTurn))
  const noteRows = messages.filter(m => m.type === 'user' && rows.isAdvisorOrigin(m.origin))
  check("each advisor row carries the fixture's note whole and the origin { advisor, model, seats 5 }", noteRows.length === 2 && String((noteRows[0]!.message as Raw).content) === 'ADVISOR-NOTE-1: you have not checked the base yet.\nDo that before the next edit.' && (noteRows[1]!.origin as Raw).model === ADVISOR_MODEL && (noteRows[1]!.origin as Raw).seats === 5 && noteRows[0]!.isMeta !== true, j(noteRows.map(m => [m.origin, (m.message as Raw).content])))
  const noteRequests = wire.filter(w => w.kind === 'advisor-note')
  check("the advisor model got exactly two note requests, each under the advisor's system prompt", noteRequests.length === 2 && noteRequests.every(w => j(w.body.system).includes('You are the Advisor')), j(noteRequests.map(w => w.body.model)))
  check('the second note request carries only the rows since the first note (turns 6–10), never turns 1–5 again', textOf(noteRequests[1]!.body).includes('operator line 6') && textOf(noteRequests[1]!.body).includes('operator line 10') && !textOf(noteRequests[1]!.body).includes('operator line 5') && textOf(noteRequests[1]!.body).includes('ADVISOR-NOTE-1'), textOf(noteRequests[1]!.body).slice(0, 300))
  check('on turn 3 the agent called AskAdvisor and got the fixture advisor\'s reply as the tool result', j(askedTools) === j(['AskAdvisor']) && askResult === 'ADVISOR-ASK-REPLY-1: run the pin on the base first.', `${j(askedTools)} · ${askResult}`)
  const askRequests = wire.filter(w => w.kind === 'advisor-ask')
  check("the ask reached the advisor model with the question and the digest (turns 1–3) under the same system prompt", askRequests.length === 1 && textOf(askRequests[0]!.body).includes('am I on the right seam?') && textOf(askRequests[0]!.body).includes('operator line 3') && j(askRequests[0]!.body.system).includes('You are the Advisor'))
  check('the note after the ask remembers the question and the reply', textOf(noteRequests[0]!.body).includes('[the agent asked') && textOf(noteRequests[0]!.body).includes('ADVISOR-ASK-REPLY-1'), textOf(noteRequests[0]!.body).slice(0, 400))
  const bucket = state.getWorkloadUsage() as Record<string, Record<string, Raw>>
  const share = bucket.advisor?.[ADVISOR_MODEL]
  check("the advisor bucket carries the three advisor calls' tokens: 270 in · 42 out, and no agent tokens", share !== undefined && share.inputTokens === 270 && share.outputTokens === 42 && Object.keys(bucket).length === 1 && bucket.advisor![AGENT_MODEL] === undefined, j(bucket))
  check("the agent's own tokens sit in the per-model ledger outside any bucket (15 requests: 12 operator turns, one more for the ask's tool round, two advisor turns)", (state.getModelUsage() as Record<string, Raw>)[AGENT_MODEL]?.inputTokens === 40 * 15 && wire.filter(w => w.kind === 'agent').length === 15, j(state.getModelUsage()))
  const memory = advisor.advisorContextPath(SESSION)
  check("the advisor's memory sits beside the session's transcript and holds the digests, the question, the reply and the notes", existsSync(memory) && readFileSync(memory, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => (JSON.parse(l) as Raw).kind).join(',') === 'head,digest,question,reply,digest,note,digest,note', existsSync(memory) ? readFileSync(memory, 'utf8').slice(0, 300) : memory)
  const { getAllBaseTools } = await import(join(ROOT, 'src/tools.ts'))
  check('with the advisor on, AskAdvisor is in the catalogue and enabled', getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME) && AskAdvisorTool.isEnabled())
}

section('§2 OFF: with advisor.enabled false nothing of it happens — no request, no row, no bucket, no tool')
{
  resetRig()
  advisor.setAdvisorEnabled(false)
  agentScript = Array.from({ length: 20 }, (_, i) => ({ text: `reply ${i + 1}` }))
  const memoryBefore = readFileSync(advisor.advisorContextPath(SESSION), 'utf8')
  const messages: AnyMsg[] = []
  for (let turn = 1; turn <= 12; turn++) {
    check(`turn ${turn}: nothing queued`, queue.getCommandQueue().length === 0)
    await mainTurn(`operator line ${turn}`, undefined, messages)
    const verdict = await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never, () => {
      throw new Error('never')
    })
    if (turn === 12) check('the road answers off without opening anything', verdict === 'off')
  }
  check('twelve turns: no advisor request left the box, no advisor row, no advisor bucket', wire.every(w => w.kind === 'agent') && messages.every(m => !rows.isAdvisorOrigin(m.origin)) && (state.getWorkloadUsage() as Raw).advisor === undefined, j(Object.keys(state.getWorkloadUsage() as Raw)))
  const { getAllBaseTools } = await import(join(ROOT, 'src/tools.ts'))
  check('AskAdvisor is out of the catalogue and disabled', !getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME) && !AskAdvisorTool.isEnabled())
  const refused = await AskAdvisorTool.call({ question: 'anyone there?' }, makeCtx() as never)
  check('a call while off answers the refusal in words, never a throw', (refused as { data: { status: string; text: string } }).data.status === 'refused' && (refused as { data: { text: string } }).data.text.includes('the advisor is off'), j(refused))
  check("the session's advisor memory from §1 gained no row", readFileSync(advisor.advisorContextPath(SESSION), 'utf8') === memoryBefore)
  check('the advisor turns never counted (no context opened)', advisor.peekAdvisorContext(SESSION) === undefined)
}

async function driveAgent(opts: { agentId: string; isAsync: boolean; transcriptSubdir?: string; querySource: string }): Promise<{ yields: AnyMsg[]; threw?: string }> {
  const ctx = makeCtx()
  const yields: AnyMsg[] = []
  let threw: string | undefined
  try {
    const stream = runAgent({
      agentDefinition: { agentType: 'advisor-rig-worker', whenToUse: 'the advisor rig', source: 'projectSettings', getSystemPrompt: () => 'You are the rig worker. Call EchoTool each round.' } as never,
      promptMessages: [createUserMessage({ content: 'work the rounds' })] as never,
      toolUseContext: ctx as never,
      canUseTool: allowAll,
      isAsync: opts.isAsync,
      canShowPermissionPrompts: false,
      querySource: opts.querySource as never,
      availableTools: TOOLS as never,
      override: { agentId: opts.agentId } as never,
      ...(opts.transcriptSubdir !== undefined ? { transcriptSubdir: opts.transcriptSubdir } : {}),
      beforeQueryStep: () => undefined,
    })
    for await (const message of stream) yields.push(message as unknown as AnyMsg)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await settle(200)
  return { yields, threw }
}

const attachmentNotes = (yields: AnyMsg[]): AnyMsg[] => yields.filter(m => m.type === 'attachment' && (m.attachment as Raw | undefined)?.type === 'queued_command' && rows.isAdvisorOrigin((m.attachment as Raw).origin))

for (const leg of [
  { name: 'CREWMATE', agentId: 'a0advisor1', isAsync: true, querySource: 'agent:custom' },
  { name: 'WORKFLOW WORKER', agentId: 'a0advisor2', isAsync: false, querySource: 'agent:custom', transcriptSubdir: 'workflows/run-fixture' },
]) {
  section(`§3 ${leg.name}: twelve tool rounds with seats 5 — the notes arrive through the pending-message drain as painted advisor rows on the agent's own transcript`)
  resetRig()
  advisorOn(5)
  agentDelayMs = 40
  agentScript = [...Array.from({ length: 12 }, (_, i) => ({ echo: `round ${i + 1}` })), { text: 'rounds done' }]
  const { yields, threw } = await driveAgent(leg)
  agentDelayMs = 0
  const requests = wire.filter(w => w.kind === 'agent')
  check(`${leg.name}: the run never threw and made thirteen agent requests`, threw === undefined && requests.length === 13, `threw=${threw ?? 'no'} requests=${requests.length}`)
  const noteRequests = wire.filter(w => w.kind === 'advisor-note')
  check(`${leg.name}: the advisor was asked twice — after the fifth and the tenth round (red on the base: never)`, noteRequests.length === 2 && textOf(noteRequests[0]!.body).includes('round 5') && !textOf(noteRequests[0]!.body).includes('round 6') && textOf(noteRequests[1]!.body).includes('round 10') && !textOf(noteRequests[1]!.body).includes('round 5"'), j(noteRequests.map(w => textOf(w.body).slice(0, 120))))
  const notes = attachmentNotes(yields)
  check(`${leg.name}: two advisor notes were drained into the agent's rows as queued_command attachments with the advisor origin, never isMeta`, notes.length === 2 && notes.every(n => (n.attachment as Raw).isMeta !== true) && String((notes[0]!.attachment as Raw).prompt).startsWith('ADVISOR-NOTE-1'), j(notes.map(n => n.attachment)))
  const framed = requests.filter(w => textOf(w.body).includes(text.ADVISOR_NOTE_HEAD))
  check(`${leg.name}: the requests after each drain carry the note framed as advice from the advisor, never as the operator's words`, framed.length >= 2 && !requests.some(w => textOf(w.body).includes('The operator sent a new message while you were working')), String(framed.length))
  await flushSessionStorage()
  await settle(200)
  const transcript = leg.transcriptSubdir === undefined
    ? getAgentTranscriptPath(leg.agentId as never)
    : join(dirname(getAgentTranscriptPath(leg.agentId as never)), leg.transcriptSubdir, `agent-${leg.agentId}.jsonl`)
  const landed = existsSync(transcript) ? readFileSync(transcript, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Raw).map(r => { try { return recordToEntry(r as never) as Raw } catch { return {} as Raw } }) : []
  const landedNotes = landed.filter(r => r.type === 'attachment' && rows.isAdvisorOrigin(((r.attachment as Raw | undefined) ?? {}).origin))
  check(`${leg.name}: both notes landed on the agent's own transcript file${leg.transcriptSubdir !== undefined ? ' under the workflow run folder' : ''}`, landedNotes.length === 2 && landed.some(r => r.type === 'assistant'), `${transcript}: ${landedNotes.length} note rows of ${landed.length}`)
  const memory = advisor.advisorContextPath(leg.agentId)
  check(`${leg.name}: the advisor's memory for the agent sits beside the session's transcripts under advisor/<agentId>.jsonl`, existsSync(memory) && readFileSync(memory, 'utf8').includes('ADVISOR-NOTE-2'), memory)
  const share = (state.getWorkloadUsage() as Record<string, Record<string, Raw>>).advisor?.[ADVISOR_MODEL]
  check(`${leg.name}: the advisor bucket carries the two notes' tokens`, share !== undefined && share.inputTokens === 180 && share.outputTokens === 28, j(share))
}

server.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} advisor roads: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
