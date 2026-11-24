#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_ADVISOR_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-roads-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'advisor-roads-daemon-'))
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

const AGENT_MODEL = 'claude-sonnet-5'
const ADVISOR_MODEL = 'claude-opus-5-5'
const AGENT_USAGE = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 6 }
const ADVISOR_USAGE = { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 14 }
const THINK = 4000
const NOTE_TOKENS = 60
const VENDOR_OUTPUT_CAP = 128_000
const ADVISOR_THINKING = 'Weighing the four decisions against each other before writing.'
const QUESTION = 'Four decisions for the release: (A) store user passwords in plain text so support can read them; (B) run the schema migration straight on production at peak hours with no dry run; (C) disable the failing tests so the release is green; (D) ship on a Friday afternoon. Which two are the most dangerous, and why?'
const ADVISOR_ANSWER = 'The two most dangerous: (A) plain-text passwords — one leak exposes every account and nothing can undo it; (B) the peak-hours migration with no dry run — a failure has no way back and takes production down with it. (C) hides a real red and (D) only costs a weekend; neither is irreversible.'
type AgentTurn = { text: string } | { ask: string; then: string } | { echo: string; then?: string }
let agentScript: AgentTurn[] = []
let agentOrdinal = 0
let agentDelayMs = 0
let advisorNotes = 0
let advisorReplies = 0
let advisorEmptyAnswers = 0
const T0 = Date.parse('2026-06-19T09:00:00.000Z')
const MINUTE = 60_000
const clock = { now: T0, tickPerAgentRequest: false }
const tick = (minutes: number): void => {
  clock.now += minutes * MINUTE
}
let onAgentRequest: (() => void) | null = null
const wire: Array<{ model: string; kind: 'agent' | 'advisor-note' | 'advisor-ask'; body: Raw }> = []
const sse = (name: string, obj: unknown): string => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
function textOf(body: Raw): string {
  return JSON.stringify(body.messages ?? '')
}
function advisorThinksFirst(model: string, maxTokens: number, text: string): string {
  const start = { ...ADVISOR_USAGE, output_tokens: 1 }
  const out: string[] = [
    sse('message_start', { type: 'message_start', message: { id: `msg_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: start } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ADVISOR_THINKING } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]
  if (maxTokens < THINK + NOTE_TOKENS) {
    out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: maxTokens, output_tokens_details: { thinking_tokens: maxTokens } } }))
    out.push(sse('message_stop', { type: 'message_stop' }))
    return out.join('')
  }
  out.push(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
  out.push(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }))
  out.push(sse('content_block_stop', { type: 'content_block_stop', index: 1 }))
  out.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: THINK + NOTE_TOKENS, output_tokens_details: { thinking_tokens: THINK } } }))
  out.push(sse('message_stop', { type: 'message_stop' }))
  return out.join('')
}
function anthropicReply(model: string, blocks: Array<{ text: string } | { thinking: string } | { toolUse: { id: string; name: string; input: Raw } }>, usage: Raw, stop: string): string {
  const out: string[] = [sse('message_start', { type: 'message_start', message: { id: `msg_${wire.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })]
  blocks.forEach((block, index) => {
    if ('text' in block) {
      out.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }))
    } else if ('thinking' in block) {
      out.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }))
      out.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'fixture-signature' } }))
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
      const maxTokens = Number(body.max_tokens)
      if (!Number.isFinite(maxTokens) || maxTokens > VENDOR_OUTPUT_CAP) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${String(body.max_tokens)} > ${VENDOR_OUTPUT_CAP}, which is the maximum allowed number of output tokens for ${model}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (advisorEmptyAnswers > 0) {
        advisorEmptyAnswers--
        res.end(anthropicReply(model, [{ thinking: 'nothing worth a note here' }], ADVISOR_USAGE, 'end_turn'))
        return
      }
      if (ask) advisorReplies++
      const text = ask ? ADVISOR_ANSWER : `ADVISOR-NOTE-${++advisorNotes}: you have not checked the base yet.\nDo that before the next edit.`
      res.end(advisorThinksFirst(model, maxTokens, text))
      return
    }
    wire.push({ model, kind: 'agent', body })
    if (clock.tickPerAgentRequest) tick(1)
    const hook = onAgentRequest
    onAgentRequest = null
    hook?.()
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

const { setIsInteractive } = await import(join(ROOT, 'src/boot/process-state/processState.ts'))
setIsInteractive(false)
const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
enableConfigs()
const state = await import(join(ROOT, 'src/boot/process-state/processState.ts'))
const config = await import(join(ROOT, 'src/platform/settings/config.ts'))
const advisor = await import(join(ROOT, 'src/models/advisor/index.ts'))
const rows = await import(join(ROOT, 'src/engine/message-shapes/noticeRows.ts'))
const text = await import(join(ROOT, 'src/engine/message-shapes/text.ts'))
const { turnDoor } = await import(join(ROOT, 'src/engine/turnDoor.ts'))
const { productionDeps } = await import(join(ROOT, 'src/engine/turn-entry/turnLoopDeps.ts'))
const { getDefaultAppState } = await import(join(ROOT, 'src/screen/app-state/AppStateStore.ts'))
const { createUserMessage } = await import(join(ROOT, 'src/engine/messages/messages.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(ROOT, 'src/platform/files/fileStateCache.ts'))
const queue = await import(join(ROOT, 'src/screen/composer/input-core/command-queue.ts'))
const { AskAdvisorTool, askAdvisorAgentId } = await import(join(ROOT, 'src/tools/ask-advisor/AskAdvisorTool.ts'))
const { ASK_ADVISOR_TOOL_NAME } = await import(join(ROOT, 'src/tools/ask-advisor/constants.ts'))
const toolsConstants = await import(join(ROOT, 'src/tools/kit/crewmateBarredTools.ts'))
const { runAgent } = await import(join(ROOT, 'src/tools/crewmate/runCrewmate.ts'))
const { getAgentTranscriptPath, getTranscriptPath } = await import(join(ROOT, 'src/sessions/transcripts/paths.ts'))
const { flushSessionStorage, recordTranscript } = await import(join(ROOT, 'src/sessions/transcripts/writer.ts'))
const { recordToEntry } = await import(join(ROOT, 'src/sessions/fabric/entryCodec.ts'))
const { getAttachments, createAttachmentMessage } = await import(join(ROOT, 'src/engine/attachments/turnAttachments.ts'))
const storage = await import(join(ROOT, 'src/sessions/transcripts/sessionStorage.ts'))
type AnyMsg = Record<string, unknown> & { type?: string }
advisor.setAdvisorClockForTests(() => clock.now)


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
      engineModel: AGENT_MODEL,
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
    startTurn: turnDoor,
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

section('§0 the wiring: one road per seat into one drain, the framing, the tool gate and its enrolment (red on the base: the main chat queued the note as a prompt)')
{
  check('the tool is barred for every crewmate: the one deny set names it with its reason (a present human — the main chat alone), and no second allow-set exists', (toolsConstants.ALL_AGENT_DISALLOWED_TOOLS as Set<string>).has(ASK_ADVISOR_TOOL_NAME) && (toolsConstants.CREWMATE_BARRED_TOOLS as Record<string, string>)[ASK_ADVISOR_TOOL_NAME] === 'present human' && !('IN_PROCESS_CREWMATE_ALLOWED_TOOLS' in toolsConstants) && !('ASYNC_AGENT_ALLOWED_TOOLS' in toolsConstants), 'change CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts so it lists AskAdvisor with the reason present human; ALL_AGENT_DISALLOWED_TOOLS derives from it and no second allow-set may exist')
  check("the tool's own words say the main chat alone, never crewmates", (await AskAdvisorTool.prompt()).includes('this tool is never available to crewmates. Its reply') && !/workflow/i.test(await AskAdvisorTool.prompt()) && !(await AskAdvisorTool.prompt()).includes('Advisor for crewmates') && (AskAdvisorTool.capability?.conditions ?? []).some(c => c.includes('the main chat alone, never crewmates; the advisor keeps')), await AskAdvisorTool.prompt())
  const { toolCensus } = await import('../builtin-tools/census-gen.ts')
  const census = toolCensus().anchor
  const row = census.rows.find(r => r.name === ASK_ADVISOR_TOOL_NAME)
  check('the census anchor rows the tool with its proof and its condition', row !== undefined && row.proof === 'scripts/advisor/run-all.sh' && (row.declared?.conditions ?? []).some(c => c.includes('Advisor on')), j(row))
  check("the tool's agent id is the session's on the main thread and the agent's for a crewmate", askAdvisorAgentId({ agentId: undefined }) === String(state.getSessionId()) && askAdvisorAgentId({ agentId: 'agent-x' as never }) === 'agent-x', 'change askAdvisorAgentId in src/tools/ask-advisor/AskAdvisorTool.ts to return the session id on the main thread and the agent id for a crewmate')
  check("the tool's input is one question", AskAdvisorTool.inputSchema.safeParse({ question: 'x' }).success && !AskAdvisorTool.inputSchema.safeParse({}).success && !AskAdvisorTool.inputSchema.safeParse({ question: 'x', extra: 1 }).success, 'change the input schema in src/tools/ask-advisor/AskAdvisorTool.ts so it takes one required question string and rejects a missing question and extra keys')
}

const SESSION = String(state.getSessionId())
const memoryOf = (agentId: string): string => (existsSync(advisor.advisorContextPath(agentId)) ? readFileSync(advisor.advisorContextPath(agentId), 'utf8') : '')
const advisorOn = (minutes: number, chat = true): void => {
  advisor.setAdvisorEnabled(true)
  advisor.setAdvisorMinutes(minutes)
  storage.saveAdvisorSwitch(chat)
  config.saveGlobalConfig(c => ({ ...c, subModels: { ...c.subModels, advisor: ADVISOR_MODEL } }))
}
const resetRig = (): void => {
  wire.length = 0
  agentOrdinal = 0
  advisorNotes = 0
  advisorReplies = 0
  clock.now = T0
  clock.tickPerAgentRequest = false
  onAgentRequest = null
  advisor.resetAdvisorContextsForTests()
  advisor.resetAdvisorRoadsForTests()
  queue.resetCommandQueue()
  state.resetCostState()
}
const isNoteRow = (m: AnyMsg): boolean => m.type === 'attachment' && (m.attachment as Raw | undefined)?.type === 'queued_command' && rows.isAdvisorOrigin((m.attachment as Raw).origin)
const notePromptOf = (m: AnyMsg): string => String((m.attachment as Raw).prompt)

async function mainTurn(prompt: string, messages: AnyMsg[]): Promise<{ yields: AnyMsg[]; landed: AnyMsg[] }> {
  const ctx = makeCtx()
  const deps = productionDeps()
  const userRow = createUserMessage({ content: prompt }) as unknown as AnyMsg
  messages.push(userRow)
  ;(ctx as { messages: unknown }).messages = messages
  const collected = (await getAttachments(prompt, ctx as never, [], messages as never, 'sdk' as never)) as Raw[]
  const landed = collected.filter(a => a.type === 'queued_command' && rows.isAdvisorOrigin(a.origin)).map(a => createAttachmentMessage(a as never) as unknown as AnyMsg)
  messages.push(...landed)
  const yields: AnyMsg[] = []
  const gen = turnDoor({
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
    if (m.type === 'assistant' || m.type === 'user' || isNoteRow(m)) messages.push(m)
    r = await gen.next()
  }
  return { yields, landed }
}

section(`§1 THE MAIN CHAT: ${ADVISOR_MODEL} advising ${AGENT_MODEL}, twelve operator turns a minute apart with the interval at 5 minutes, the advisor thinking ${THINK} tokens before every answer — the notes composed at the ends of turns 5 and 10 land as advisor rows INSIDE turns 6 and 11, beside the operator's prompt, never as a turn of their own; the agent's AskAdvisor question comes back answered in words; the advisor bucket carries the thinking (red on the base: the note queued as a prompt and took a turn)`)
{
  resetRig()
  advisorOn(5)
  agentScript = Array.from({ length: 20 }, (_, i) => (i === 2 ? { ask: QUESTION, then: 'reply 3' } : { text: `reply ${i + 1}` }))
  await advisor.loadAdvisorContext(SESSION)
  const messages: AnyMsg[] = []
  const verdicts: string[] = []
  const rowsAfterTurn: number[] = []
  const landedAt: number[] = []
  let askResult = ''
  let askedTools: string[] = []
  for (let turn = 1; turn <= 12; turn++) {
    check(`turn ${turn}: nothing is queued for the agent — a note never starts a turn`, queue.getCommandQueue().length === 0, 'change the advisor delivery in src/models/advisor/advisorRoads.ts so a note is stashed for the next boundary and never queued as a command')
    const { yields, landed } = await mainTurn(`operator line ${turn}`, messages)
    if (landed.length > 0) landedAt.push(turn)
    if (turn === 3) {
      askedTools = yields.filter(m => m.type === 'assistant').flatMap(m => ((m.message as Raw).content as AnyMsg[]).filter(b => b.type === 'tool_use').map(b => String(b.name)))
      askResult = toolResultsOf(yields).find(t => t.id.startsWith('tu_ask'))?.text ?? ''
    }
    tick(1)
    verdicts.push(await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never))
    rowsAfterTurn.push(messages.filter(isNoteRow).length)
  }
  check("the turn ends' verdicts: waiting until five minutes have passed, delivered at the ends of turns 5 and 10, waiting between (red on the base: a turn counter)", j(verdicts) === j(['waiting', 'waiting', 'waiting', 'waiting', 'delivered', 'waiting', 'waiting', 'waiting', 'waiting', 'delivered', 'waiting', 'waiting']), j(verdicts))
  check('each note landed beside the very next operator prompt — inside turns 6 and 11 — and no other turn carried one', j(landedAt) === j([6, 11]), j(landedAt))
  check('advisor rows in the transcript: none through turn 5, one from turn 6, two from turn 11, every one an attachment row (red on the base: user rows the advisor started turns with)', j(rowsAfterTurn) === j([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2]) && messages.every(m => !(m.type === 'user' && rows.isAdvisorOrigin(m.origin))), j(rowsAfterTurn))
  const noteRows = messages.filter(isNoteRow)
  check("each advisor row carries the fixture's note whole and the origin { advisor, model, minutes 5 }, never isMeta", noteRows.length === 2 && notePromptOf(noteRows[0]!) === 'ADVISOR-NOTE-1: you have not checked the base yet.\nDo that before the next edit.' && ((noteRows[1]!.attachment as Raw).origin as Raw).model === ADVISOR_MODEL && ((noteRows[1]!.attachment as Raw).origin as Raw).minutes === 5 && (noteRows[1]!.attachment as Raw).isMeta !== true, j(noteRows.map(m => m.attachment)))
  const operatorSix = messages.findIndex(m => m.type === 'user' && j((m.message as Raw).content).includes('operator line 6'))
  check("the first note's row stands right after the operator's sixth prompt and before the reply that reads it", operatorSix >= 0 && messages[operatorSix + 1] === noteRows[0] && messages[operatorSix + 2]?.type === 'assistant', j(messages.slice(operatorSix, operatorSix + 3).map(m => m.type)))
  const noteRequests = wire.filter(w => w.kind === 'advisor-note')
  check("the advisor model got exactly two note requests, each under the advisor's system prompt", noteRequests.length === 2 && noteRequests.every(w => j(w.body.system).includes('You are the Advisor')), j(noteRequests.map(w => w.body.model)))
  check('the second note request carries only the rows since the first note (turns 6–10), never turns 1–5 again, and the advisor remembers its first note', textOf(noteRequests[1]!.body).includes('operator line 6') && textOf(noteRequests[1]!.body).includes('operator line 10') && !textOf(noteRequests[1]!.body).includes('operator line 5') && textOf(noteRequests[1]!.body).includes('ADVISOR-NOTE-1'), textOf(noteRequests[1]!.body).slice(0, 300))
  const agentRequests = wire.filter(w => w.kind === 'agent')
  const framed = agentRequests.filter(w => textOf(w.body).includes(text.ADVISOR_NOTE_HEAD))
  const bare = agentRequests.filter(w => textOf(w.body).includes('ADVISOR-NOTE-') && !textOf(w.body).includes(text.ADVISOR_NOTE_HEAD))
  check("THE FRAMING the model reads: from turn 6 on every request carries the note as advice from a second model, never as the operator's words, and no request ever carried the note bare as a prompt (red on the base: a user turn of the note's words)", framed.length === agentRequests.length - 6 && bare.length === 0 && !agentRequests.some(w => textOf(w.body).includes('The operator sent a new message while you were working')) && text.ADVISOR_NOTE_HEAD.includes('not the operator'), j({ framed: framed.length, bare: bare.length, requests: agentRequests.length }))
  const namedLetters = (words: string): string[] => ['A', 'B', 'C', 'D'].filter(letter => new RegExp(`\\(${letter}\\)`).test(words))
  const answersIt = (words: string): boolean => namedLetters(words).length >= 2 && words.split(/\s+/).length >= 15 && !words.includes('did not answer') && !words.includes('answered with no text')
  check('on turn 3 the agent asked the advisor the four-decisions question and the tool result is the advisor\'s words: two of the four named by letter, each with its reason (red on the base: "The advisor did not answer: the advisor answered with no text")', j(askedTools) === j(['AskAdvisor']) && askResult === ADVISOR_ANSWER && answersIt(askResult) && j(namedLetters(askResult)).startsWith('["A","B"'), `${j(askedTools)} · ${askResult}`)
  check("the advisor's thinking never leaks into the tool result — the agent reads the words alone", !askResult.includes(ADVISOR_THINKING) && askResult.split('\n').length <= 8, askResult)
  const askRequests = wire.filter(w => w.kind === 'advisor-ask')
  check("the ask reached the advisor model with the question and the digest (turns 1–3) under the same system prompt", askRequests.length === 1 && textOf(askRequests[0]!.body).includes('Which two are the most dangerous, and why?') && textOf(askRequests[0]!.body).includes('operator line 3') && j(askRequests[0]!.body.system).includes('You are the Advisor'), `${askRequests.length} ask request(s) — change askAdvisor in src/models/advisor/askAdvisor.ts so the ask carries the question and the digest of turns 1 to 3 under the advisor system prompt`)
  check(`the ask and both notes rode the model's own ceiling with no thinking key (the always-on law) — red on the base: max_tokens 1200`, [...askRequests, ...noteRequests].every(w => w.body.max_tokens === VENDOR_OUTPUT_CAP && !('thinking' in w.body)), j([...askRequests, ...noteRequests].map(w => w.body.max_tokens)))
  check('the note after the ask remembers the question and the reply', textOf(noteRequests[0]!.body).includes('[the agent asked') && textOf(noteRequests[0]!.body).includes('plain-text passwords'), textOf(noteRequests[0]!.body).slice(0, 400))
  const bucket = state.getWorkloadUsage() as Record<string, Record<string, Raw>>
  const share = bucket.advisor?.[ADVISOR_MODEL]
  check(`the advisor bucket carries the three advisor calls' tokens with their thinking: 270 in · ${3 * (THINK + NOTE_TOKENS)} out, and no agent tokens`, share !== undefined && share.inputTokens === 270 && share.outputTokens === 3 * (THINK + NOTE_TOKENS) && Object.keys(bucket).length === 1 && bucket.advisor![AGENT_MODEL] === undefined, j(bucket))
  check("the agent's own tokens sit in the per-model ledger outside any bucket (13 requests: 12 operator turns and one more for the ask's tool round — the notes cost the agent no turn; red on the base: 15)", (state.getModelUsage() as Record<string, Raw>)[AGENT_MODEL]?.inputTokens === 40 * 13 && agentRequests.length === 13, j(state.getModelUsage()))
  const memory = advisor.advisorContextPath(SESSION)
  check("the advisor's memory sits beside the session's transcript and holds the digests, the question, the reply and the notes", existsSync(memory) && readFileSync(memory, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => (JSON.parse(l) as Raw).kind).join(',') === 'head,digest,question,reply,digest,note,digest,note', existsSync(memory) ? readFileSync(memory, 'utf8').slice(0, 300) : memory)
  const { getAllBaseTools } = await import(join(ROOT, 'src/tools/kit/toolList.ts'))
  check('with the advisor on, AskAdvisor is in the catalogue and enabled', getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME) && AskAdvisorTool.isEnabled(), 'change the advisorEnabled() entry in src/tools/kit/toolList.ts and AskAdvisorTool.isEnabled in src/tools/ask-advisor/AskAdvisorTool.ts so the tool is listed and enabled while the advisor is on')
}

section("§1c INSIDE A RUNNING TURN: a note composed while the agent's first request is in flight lands at the turn's next tool-round boundary — after the tool result, before the reply that reads it — never beside the prompt it missed and never as a turn (red on the base: a note waited for the next turn)")
{
  resetRig()
  advisorOn(5)
  agentScript = [{ text: 'reply 1' }, { echo: 'a tool call' }, { text: 'reply after the tool' }]
  const resumed = await advisor.loadAdvisorContext(SESSION)
  clock.now = advisor.advisorClockStart(resumed)
  check("a resumed context's clock is its last note's stamp on disk, not the moment it was opened", clock.now === T0 + 10 * MINUTE && advisor.advisorLastNoteAt(resumed) === T0 + 10 * MINUTE, String(clock.now - T0))
  const messages: AnyMsg[] = []
  await mainTurn('operator line 1', messages)
  tick(5)
  check('five minutes on, the note is due and nothing has been composed yet', advisor.advisorNoteDue(advisor.peekAdvisorContext(SESSION)!, 5, clock.now) && advisor.peekAdvisorNotes(SESSION).length === 0, 'change advisorNoteDue in src/models/advisor/advisorNote.ts to read due once the interval has passed, with no note composed or stashed yet')
  agentDelayMs = 80
  const round: { verdict: Promise<string> | null } = { verdict: null }
  onAgentRequest = () => {
    round.verdict = advisor.advisorMainRound(SESSION, messages as never)
  }
  const { yields, landed } = await mainTurn('operator line 2', messages)
  agentDelayMs = 0
  const verdict = round.verdict === null ? 'never kicked' : await round.verdict
  check('the round composed and stashed its note while the turn ran, and the boundary took it', verdict === 'delivered' && advisor.peekAdvisorNotes(SESSION).length === 0, verdict)
  check('nothing landed beside the prompt (the note was not there yet) and nothing was queued', landed.length === 0 && queue.getCommandQueue().length === 0, j({ landed: landed.length, queued: queue.getCommandQueue().length }) + ' — change advisorMainRound in src/models/advisor/advisorRoads.ts to stash the note for the tool-round boundary and never queue it or land it beside the prompt')
  const kinds = yields.map(m => (isNoteRow(m) ? 'note' : m.type === 'user' ? 'tool_result' : String(m.type)))
  const noteAt = kinds.indexOf('note')
  const resultAt = kinds.indexOf('tool_result')
  const replyAt = kinds.lastIndexOf('assistant')
  check("the note's attachment row was yielded after the tool result and before the reply that reads it — inside the turn", noteAt > resultAt && resultAt >= 0 && noteAt < replyAt, j(kinds))
  const turnRequests = wire.filter(w => w.kind === 'agent').slice(-2)
  check("the turn's first request carried no note; its second, after the boundary, carried it framed as advice from a second model", turnRequests.length === 2 && !textOf(turnRequests[0]!.body).includes('ADVISOR-NOTE-1') && textOf(turnRequests[1]!.body).includes(text.ADVISOR_NOTE_HEAD) && textOf(turnRequests[1]!.body).includes('ADVISOR-NOTE-1') && !textOf(turnRequests[1]!.body).includes('The operator sent a new message'), j(turnRequests.map(w => textOf(w.body).slice(-200))))
  check('the transcript list holds the note as an attachment row in that place, and no advisor-origin user row anywhere', messages.filter(isNoteRow).length === 1 && messages.every(m => !(m.type === 'user' && rows.isAdvisorOrigin(m.origin))), j(messages.map(m => (isNoteRow(m) ? 'note' : m.type))))
}

section("§1b THE QUIET ROUND on the main chat: the advisor answers thinking only, twice, at the end of turn 5 — the chat gets one muted [advisor] row as a system record, the agent gets no turn and never reads it, and the next boundary asks nothing more (red on the base: one advisor request, silence)")
{
  resetRig()
  advisorOn(5)
  agentScript = Array.from({ length: 20 }, (_, i) => ({ text: `reply ${i + 1}` }))
  advisorEmptyAnswers = 2
  clock.now = advisor.advisorClockStart(await advisor.loadAdvisorContext(SESSION))
  const memoryBefore = memoryOf(SESSION)
  const messages: AnyMsg[] = []
  const quietRows: AnyMsg[] = []
  const verdicts: string[] = []
  for (let turn = 1; turn <= 6; turn++) {
    check(`turn ${turn}: nothing queued for the agent`, queue.getCommandQueue().length === 0, 'change advisorMainTurnSettled in src/models/advisor/advisorRoads.ts so a quiet or waiting round queues nothing for the agent')
    await mainTurn(`operator line ${turn}`, messages)
    await recordTranscript(messages as never, undefined, messages as never)
    tick(1)
    const verdict = await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never, {
      onQuiet: quiet => {
        const row = advisor.createAdvisorQuietMessage(quiet)
        messages.push(row as unknown as AnyMsg)
        quietRows.push(row as unknown as AnyMsg)
        void recordTranscript([row] as never, undefined, messages as never)
      },
    })
    verdicts.push(verdict)
  }
  check('the verdicts: waiting through turn 4, quiet at turn 5, waiting again at turn 6 — the quiet look starts the interval over (red on the base: silent at turn 5)', j(verdicts) === j(['waiting', 'waiting', 'waiting', 'waiting', 'quiet', 'waiting']), j(verdicts))
  const noteRequests = wire.filter(w => w.kind === 'advisor-note')
  check('the advisor was asked twice for the one round — once more after the empty answer, never a third time (red on the base: once)', noteRequests.length === 2 && textOf(noteRequests[1]!.body) === textOf(noteRequests[0]!.body), String(noteRequests.length))
  check("nothing was queued or stashed for the agent and it made exactly six requests — a quiet round costs the agent no turn", queue.getCommandQueue().length === 0 && advisor.peekAdvisorNotes(SESSION).length === 0 && wire.filter(w => w.kind === 'agent').length === 6, String(wire.filter(w => w.kind === 'agent').length))
  const quietRow = quietRows[0]
  check('one quiet row landed in the session list after turn 5, a system record with the advisor origin and the had-nothing words', quietRows.length === 1 && quietRow !== undefined && advisor.isAdvisorQuietMessage(quietRow) && rows.isAdvisorOrigin((quietRow as Raw).origin) && ((quietRow as Raw).origin as Raw).model === ADVISOR_MODEL && String((quietRow as Raw).content) === 'had nothing to say this round — answered with no text, twice' && messages.indexOf(quietRow) > messages.findIndex(m => m.type === 'user' && j((m.message as Raw).content).includes('operator line 5')), j(quietRow))
  check('no advisor-origin user row exists: the quiet row is not a note', messages.every(m => !(m.type === 'user' && rows.isAdvisorOrigin(m.origin))), 'change createAdvisorQuietMessage in src/models/advisor/advisorQuiet.ts so the quiet row is a system record and never a user row with the advisor origin')
  const { normalizeMessagesForAPI } = await import(join(ROOT, 'src/engine/messages/apiView.ts'))
  const planned = normalizeMessagesForAPI(messages as never)
  check("the API plan never carries the quiet row — the agent's requests after it read no such words", !j(planned).includes('had nothing to say') && !textOf(wire.filter(w => w.kind === 'agent').at(-1)!.body).includes('had nothing to say'), 'change normalizeMessagesForAPI in src/engine/messages/apiView.ts to drop the advisor quiet system row from the API plan')
  await flushSessionStorage()
  await settle(200)
  const transcriptPath = getTranscriptPath()
  const onDisk = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Raw).map(r => { try { return recordToEntry(r as never) as Raw } catch { return {} as Raw } }) : []
  const landed = onDisk.filter(r => r.type === 'system' && r.subtype === 'advisor_quiet')
  check("the quiet row is on the session's transcript file, once, with its origin and words whole — the record the interactive chat paints (red on the base: no such record)", landed.length === 1 && j((landed[0] as Raw).origin) === j((quietRow as Raw).origin) && (landed[0] as Raw).content === (quietRow as Raw).content && (landed[0] as Raw).uuid === (quietRow as Raw).uuid, `${transcriptPath}: ${landed.length} quiet row(s) of ${onDisk.length}`)
  const memoryAfter = memoryOf(SESSION)
  check("the advisor's memory gained no row for the quiet round", memoryAfter === memoryBefore, memoryAfter.slice(memoryBefore.length, memoryBefore.length + 200))
  advisorEmptyAnswers = 0
}

section('§2 OFF: with advisor.enabled false nothing of it happens — no request, no row, no bucket, no tool')
{
  resetRig()
  advisor.setAdvisorEnabled(false)
  agentScript = Array.from({ length: 20 }, (_, i) => ({ text: `reply ${i + 1}` }))
  const memoryBefore = memoryOf(SESSION)
  const messages: AnyMsg[] = []
  for (let turn = 1; turn <= 12; turn++) {
    check(`turn ${turn}: nothing queued`, queue.getCommandQueue().length === 0)
    await mainTurn(`operator line ${turn}`, messages)
    tick(10)
    const verdict = await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never)
    if (turn === 12) check('the road answers off without opening anything', verdict === 'off', `verdict ${verdict} — change advisorMainTurnSettled in src/models/advisor/advisorRoads.ts to answer off when advisor.enabled is false`)
  }
  check('twelve turns two hours apart: no advisor request left the box, no advisor row, no advisor bucket', wire.every(w => w.kind === 'agent') && messages.every(m => !rows.isAdvisorOrigin(m.origin) && !isNoteRow(m)) && (state.getWorkloadUsage() as Raw).advisor === undefined, j(Object.keys(state.getWorkloadUsage() as Raw)))
  check('a bash line is not a boundary the advisor composes at; a prompt and a task notification are', advisor.advisorMainTurnIsBoundary({ mode: 'prompt' }) && advisor.advisorMainTurnIsBoundary({ mode: 'task-notification' }) && !advisor.advisorMainTurnIsBoundary({ mode: 'bash' }) && (await advisor.advisorMainTurnSettled(SESSION, { mode: 'bash' } as never, messages as never)) === 'skipped', 'change advisorMainTurnIsBoundary in src/models/advisor/advisorRoads.ts to count prompt and task-notification as boundaries and bash as none, and advisorMainTurnSettled to answer skipped for a non-boundary')
  const { getAllBaseTools } = await import(join(ROOT, 'src/tools/kit/toolList.ts'))
  check('AskAdvisor is out of the catalogue and disabled', !getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME) && !AskAdvisorTool.isEnabled(), 'change the advisorEnabled() entry in src/tools/kit/toolList.ts and AskAdvisorTool.isEnabled in src/tools/ask-advisor/AskAdvisorTool.ts so the tool is out of the catalogue and disabled while advisor.enabled is false')
  const refused = await AskAdvisorTool.call({ question: 'anyone there?' }, makeCtx() as never)
  check('a call while off answers the refusal in words, never a throw', (refused as { data: { status: string; text: string } }).data.status === 'refused' && (refused as { data: { text: string } }).data.text.includes('the advisor is off'), j(refused))
  check("the session's advisor memory from §1 gained no row", memoryOf(SESSION) === memoryBefore, memoryOf(SESSION).slice(memoryBefore.length, memoryBefore.length + 200) + ' — change the advisor roads in src/models/advisor so no memory row is written while the advisor is off')
  check('the advisor turns never counted (no context opened)', advisor.peekAdvisorContext(SESSION) === undefined, 'change advisorMainTurnSettled in src/models/advisor/advisorRoads.ts to answer off before opening a context while the advisor is disabled')
}

section("§2b THIS CHAT'S OWN SWITCH on the real query road: the settings on and the chat's switch off — twelve turns two hours apart spend nothing and AskAdvisor is out of the catalogue; /advise on inside the session turns it on from the next boundary, the tool joins the catalogue, and /advise off stops it again (red on the base: the settings alone served every session)")
{
  resetRig()
  advisorOn(5, false)
  agentScript = Array.from({ length: 30 }, (_, i) => ({ text: `reply ${i + 1}` }))
  const { getAllBaseTools } = await import(join(ROOT, 'src/tools/kit/toolList.ts'))
  const { runAdviseCommand } = await import(join(ROOT, 'src/commands/advise/advise.ts'))
  const messages: AnyMsg[] = []
  const verdicts: string[] = []
  for (let turn = 1; turn <= 12; turn++) {
    await mainTurn(`operator line ${turn}`, messages)
    tick(10)
    verdicts.push(await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never))
  }
  check("with the settings on and this chat's switch off, every turn end reads off: no advisor request, no advisor row, no context, no bucket", verdicts.every(v => v === 'off') && wire.every(w => w.kind === 'agent') && messages.every(m => !isNoteRow(m)) && advisor.peekAdvisorContext(SESSION) === undefined && (state.getWorkloadUsage() as Raw).advisor === undefined, j(verdicts))
  check('AskAdvisor is out of the catalogue and disabled while the chat is off', !getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME) && !AskAdvisorTool.isEnabled(), 'change the advisorEnabled() entry in src/tools/kit/toolList.ts and AskAdvisorTool.isEnabled in src/tools/ask-advisor/AskAdvisorTool.ts so the chat switch takes the tool out of the catalogue')
  const refused = await AskAdvisorTool.call({ question: 'anyone there?' }, makeCtx() as never)
  check("a stale tool call refuses naming this chat's switch", (refused as { data: { status: string; text: string } }).data.status === 'refused' && (refused as { data: { text: string } }).data.text.includes(advisor.ADVISOR_CHAT_OFF_REFUSAL), j(refused))
  const line = runAdviseCommand('on')
  check('/advise on in the session answers the state line for this chat and flips its record', line === `advisor on for this chat · ${ADVISOR_MODEL} · every 5 minutes` && storage.advisorSwitchOfSession() === true, line)
  check('the tool joins the catalogue at once and is enabled', getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME) && AskAdvisorTool.isEnabled(), 'change the advisorEnabled() entry in src/tools/kit/toolList.ts so the tool joins the catalogue once the chat switch is on')
  const opened = await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never)
  const { landed } = await mainTurn('operator line 13', messages)
  check("from the very next boundary the chat is advised: the record's last note is hours old, so the note is composed at once (delivered) and lands inside the next turn beside the operator's prompt", opened === 'delivered' && landed.length === 1 && wire.filter(w => w.kind === 'advisor-note').length === 1, j({ opened, landed: landed.length }))
  tick(5)
  const again = await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never)
  const off = runAdviseCommand('off')
  tick(10)
  await mainTurn('operator line 14', messages)
  const stopped = await advisor.advisorMainTurnSettled(SESSION, { mode: 'prompt' } as never, messages as never)
  check('five minutes on the next boundary composes again; /advise off then stops it from the boundary after and the tool leaves the catalogue', again === 'delivered' && off.startsWith('advisor off for this chat') && stopped === 'off' && wire.filter(w => w.kind === 'advisor-note').length === 2 && !getAllBaseTools().some((t: { name: string }) => t.name === ASK_ADVISOR_TOOL_NAME), j({ again, off, stopped, notes: wire.filter(w => w.kind === 'advisor-note').length }))
  check('the bare line reads the state without changing it', runAdviseCommand('') === off && storage.advisorSwitchOfSession() === false, 'change runAdviseCommand in src/commands/advise/advise.ts so the bare line reports the state and does not change it')
}

section("§2c THE SWITCH ON THE SESSION'S OWN RECORD: /advise on writes an advisor-switch entry on the transcript beside the title and the mode; every resume road reads the last one back and seeds the chat's switch, so a resumed session remembers it was on — or off (red on the base: no per-chat record)")
{
  resetRig()
  advisorOn(5, false)
  agentScript = Array.from({ length: 6 }, (_, i) => ({ text: `reply ${i + 1}` }))
  const messages: AnyMsg[] = []
  await mainTurn('a line to materialize the file', messages)
  await recordTranscript(messages as never, undefined, messages as never)
  await flushSessionStorage()
  const { loadConversationForResume } = await import(join(ROOT, 'src/sessions/resume/conversationRecovery.ts'))
  const { SNAPSHOT_SCHEMA } = await import(join(ROOT, 'src/sessions/transcripts/resumeSnapshot.ts'))
  const transcriptPath = getTranscriptPath()
  const recordsOf = (): Raw[] => (existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Raw) : [])
  const switchRecords = (): Raw[] => recordsOf().filter(r => JSON.stringify(r).includes('"metaKind":"advisor-switch"'))
  const before = switchRecords().length
  const resumedBefore = await loadConversationForResume(SESSION, transcriptPath)
  check('the record as it stands reads the switch as last written (off from this section\'s own advisorOn)', resumedBefore?.advisor === false, j({ before, advisor: resumedBefore?.advisor }))
  storage.saveAdvisorSwitch(true)
  await flushSessionStorage()
  await settle(100)
  const resumedOn = await loadConversationForResume(SESSION, transcriptPath)
  check("/advise on writes through at once: one more advisor-switch record reading on, and the resume loader reads advisor: true back", switchRecords().length === before + 1 && JSON.stringify(switchRecords().at(-1)).includes('"on":true') && resumedOn?.advisor === true, j({ records: switchRecords().length - before, advisor: resumedOn?.advisor }))
  storage.saveAdvisorSwitch(false)
  await flushSessionStorage()
  await settle(100)
  const resumedOff = await loadConversationForResume(SESSION, transcriptPath)
  check('/advise off appends one more record reading off, and the loader reads the LAST one: advisor: false', switchRecords().length === before + 2 && JSON.stringify(switchRecords().at(-1)).includes('"on":false') && resumedOff?.advisor === false, j({ records: switchRecords().length - before, advisor: resumedOff?.advisor }))
  storage.clearSessionMetadata()
  check("the metadata cache cleared reads as off (a fresh chat's state)", storage.advisorSwitchOfSession() === false)
  storage.restoreSessionMetadata({ advisor: true })
  check('the resume roads seed the switch through restoreSessionMetadata: the chat reads on without anyone typing /advise', storage.advisorSwitchOfSession() === true && advisor.advisorChatSwitch() === true, 'change restoreSessionMetadata in src/sessions/transcripts/sessionListings.ts to seed the chat advisor switch from the advisor field')
  storage.restoreSessionMetadata({ advisor: false })
  check('…and a record reading off seeds off', storage.advisorSwitchOfSession() === false)
  storage.restoreSessionMetadata({})
  check('a record with no switch leaves the cache as it stands', storage.advisorSwitchOfSession() === false)
  check('the resume snapshot schema moved past the one older builds wrote, so a snapshot without the switch map is never trusted', SNAPSHOT_SCHEMA >= 3, `SNAPSHOT_SCHEMA is ${String(SNAPSHOT_SCHEMA)} — raise it in src/sessions/transcripts/resumeSnapshot.ts`)
}

async function driveAgent(opts: { agentId: string; isAsync: boolean; querySource: string; agentKind?: 'crewmate' }): Promise<{ yields: AnyMsg[]; threw?: string; childContext?: Raw }> {
  const ctx = makeCtx()
  const yields: AnyMsg[] = []
  let threw: string | undefined
  let childContext: Raw | undefined
  try {
    const stream = runAgent({
      agentDefinition: { agentType: 'advisor-rig-worker', whenToUse: 'the advisor rig', source: 'projectSettings', getSystemPrompt: () => 'You are the rig worker. Call EchoTool each round.' } as never,
      promptMessages: [createUserMessage({ content: 'work the rounds' })] as never,
      toolUseContext: ctx as never,
      canUseTool: allowAll,
      isAsync: opts.isAsync,
      agentKind: opts.agentKind,
      onCacheSafeParams: (params: { toolUseContext: unknown }) => { childContext = params.toolUseContext as Raw },
      canShowPermissionPrompts: false,
      querySource: opts.querySource as never,
      availableTools: TOOLS as never,
      override: { agentId: opts.agentId } as never,
    })
    for await (const message of stream) yields.push(message as unknown as AnyMsg)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await settle(200)
  return { yields, threw, childContext }
}

const attachmentNotes = (yields: AnyMsg[]): AnyMsg[] => yields.filter(m => m.type === 'attachment' && (m.attachment as Raw | undefined)?.type === 'queued_command' && rows.isAdvisorOrigin((m.attachment as Raw).origin))

for (const leg of [
  { name: 'CREWMATE', agentId: 'a0advisor1', isAsync: true, querySource: 'agent:custom' },
  { name: 'FOREGROUND CREWMATE', agentId: 'a0advisor2', isAsync: false, querySource: 'agent:custom' },
]) {
  section(`§3 ${leg.name}: twelve tool rounds a minute apart with the settings on at 5 minutes, through the product's own boundary and clock — the advisor never reads a crewmate: no request, no note, no memory, no tool, no spend (red on the base: two notes under a crewmate opt-in)`)
  resetRig()
  advisorOn(5)
  agentDelayMs = 40
  clock.tickPerAgentRequest = true
  agentScript = [...Array.from({ length: 12 }, (_, i) => ({ echo: `round ${i + 1}` })), { text: 'rounds done' }]
  const { yields, threw, childContext } = await driveAgent(leg)
  check(`${leg.name}: AskAdvisor is out of the child's own catalogue with the settings on`, childContext !== undefined && !(((childContext.options as Raw)?.tools as Array<{ name: string }> ?? []).some(t => t.name === ASK_ADVISOR_TOOL_NAME)), 'change CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts so AskAdvisor stays out of a crewmate catalogue')
  agentDelayMs = 0
  clock.tickPerAgentRequest = false
  const requests = wire.filter(w => w.kind === 'agent')
  check(`${leg.name}: the run never threw and made thirteen agent requests`, threw === undefined && requests.length === 13, `threw=${threw ?? 'no'} requests=${requests.length}`)
  check(`${leg.name}: no advisor request left the box across the twelve boundaries, and no note was drained into the agent's rows`, wire.every(w => w.kind === 'agent') && attachmentNotes(yields).length === 0, j(wire.map(w => w.kind)))
  check(`${leg.name}: no advisor context opened for the agent and no memory file was written`, advisor.peekAdvisorContext(leg.agentId) === undefined && !existsSync(advisor.advisorContextPath(leg.agentId)), advisor.advisorContextPath(leg.agentId))
  check(`${leg.name}: no request carried the advisor's framing`, !requests.some(w => textOf(w.body).includes(text.ADVISOR_NOTE_HEAD)), 'change the advisor roads in src/models/advisor/advisorRoads.ts so a crewmate agent never receives or is framed with a note')
  check(`${leg.name}: no advisor spend`, (state.getWorkloadUsage() as Raw).advisor === undefined, j(Object.keys(state.getWorkloadUsage() as Raw)))
}

section('§4 every disallowed seat: no scheduled call, context, note, spend or AskAdvisor catalogue entry; stale direct calls refuse and name the seat')
for (const agentKind of ['crewmate'] as const) {
  for (const enabled of [false, true]) {
    resetRig()
    advisorOn(1)
    advisor.setAdvisorEnabled(enabled)
    const id = `denied-${agentKind}-${enabled}`
    agentScript = [{ echo: 'first tool round' }, { echo: 'second tool round' }, { text: 'done' }]
    const { yields, threw, childContext } = await driveAgent({ agentId: id, isAsync: agentKind === 'crewmate', agentKind, querySource: 'agent:custom' })
    check(`${id}: the custom-definition agent finishes without advice`, threw === undefined && wire.filter(w => w.kind === 'agent').length === 3 && wire.every(w => w.kind === 'agent') && attachmentNotes(yields).length === 0, j({ threw, requests: wire.map(w => w.kind) }))
    check(`${id}: AskAdvisor is absent from the actual child catalogue`, childContext !== undefined && !((childContext.options as Raw).tools as Array<{ name: string }>).some(t => t.name === ASK_ADVISOR_TOOL_NAME), 'change CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts so AskAdvisor stays out of a crewmate catalogue')
    const before = wire.length
    const refused = await AskAdvisorTool.call({ question: QUESTION }, childContext as never) as { data: { status: string; text: string } }
    check(`${id}: a stale direct tool call refuses before any network or memory`, refused.data.status === 'refused' && wire.length === before && advisor.peekAdvisorContext(id) === undefined && !existsSync(advisor.advisorContextPath(id)), j(refused))
    check(`${id}: no advisor spend`, (state.getWorkloadUsage() as Raw).advisor === undefined, j(Object.keys(state.getWorkloadUsage() as Raw)) + ' — change the advisor refusal road in src/tools/ask-advisor/AskAdvisorTool.ts so a refused call records no advisor usage')
    check(`${id}: the refusal names the seat's permanent exclusion, whatever the settings say`, refused.data.text.includes(advisor.ADVISOR_CREWMATE_REFUSAL), refused.data.text)
  }
}

section("§5 a crewmate's direct ask is refused with the settings on; a stashed agent note is never drained; the main chat's stash waits for its own model-bound collection")
{
  resetRig()
  advisorOn(1)
  const ctx = makeCtx('crew-direct-ask')
  ctx.agentKind = 'crewmate'
  const before = wire.length
  const denied = await AskAdvisorTool.call({ question: QUESTION }, ctx as never) as { data: { status: string; text: string } }
  check('a crewmate context asking through the tool is refused before any network, the refusal naming crewmates (red on the base: answered under the opt-in)', denied.data.status === 'refused' && wire.length === before && denied.data.text.includes(advisor.ADVISOR_CREWMATE_REFUSAL), j(denied))
  const bareAgent = makeCtx('agent-no-kind')
  const bareDenied = await AskAdvisorTool.call({ question: QUESTION }, bareAgent as never) as { data: { status: string; text: string } }
  check('an agent context with no kind word is a crewmate to the advisor: refused the same way', bareDenied.data.status === 'refused' && wire.length === before && bareDenied.data.text.includes(advisor.ADVISOR_CREWMATE_REFUSAL), j(bareDenied))
  const { getAdvisorNoteAttachments, isMainChatAdvisorDrain } = await import(join(ROOT, 'src/engine/attachments/queuedCommands.ts'))
  const note = { text: 'a note queued before the toggle', origin: { kind: 'advisor', model: ADVISOR_MODEL, minutes: 1, at: new Date().toISOString() } }
  for (const kind of ['crewmate'] as const) {
    ctx.agentKind = kind
    advisor.stashAdvisorNote('crew-direct-ask', note as never)
    check(`a note stashed under an agent id is never drained into a ${kind}'s rows (the stash stands untaken; nothing stashes for an agent any more)`, getAdvisorNoteAttachments(ctx as never).length === 0 && advisor.peekAdvisorNotes('crew-direct-ask').length === 1, 'change getAdvisorNoteAttachments in src/engine/attachments/queuedCommands.ts to return nothing for a context with an agent id and leave the stash untaken')
    advisor.takeAdvisorNotes('crew-direct-ask')
  }
  advisor.stashAdvisorNote(SESSION, note as never)
  const mainCtx = { agentId: undefined }
  check("the main chat's stash waits for the main chat's OWN model-bound collection: a memory fork, a bash line, an unnamed source take nothing and leave the note", getAdvisorNoteAttachments(mainCtx as never, { querySource: 'session_memory' }).length === 0 && getAdvisorNoteAttachments(mainCtx as never, { querySource: 'sdk', localSubmission: true }).length === 0 && getAdvisorNoteAttachments(mainCtx as never, {}).length === 0 && advisor.peekAdvisorNotes(SESSION).length === 1 && !isMainChatAdvisorDrain({ agentId: 'a1', querySource: 'sdk', localSubmission: false }) && isMainChatAdvisorDrain({ agentId: undefined, querySource: 'main_thread', localSubmission: false }), 'change isMainChatAdvisorDrain and getAdvisorNoteAttachments in src/engine/attachments/queuedCommands.ts to drain the main chat stash only on its own model-bound collection')
  const mainDrained = getAdvisorNoteAttachments(mainCtx as never, { querySource: 'sdk' }) as Raw[]
  check("…and the session's own turn takes it, once, as a queued_command attachment with the origin", mainDrained.length === 1 && mainDrained[0]!.type === 'queued_command' && mainDrained[0]!.prompt === note.text && j(mainDrained[0]!.origin) === j(note.origin) && mainDrained[0]!.isMeta === undefined && advisor.peekAdvisorNotes(SESSION).length === 0 && getAdvisorNoteAttachments(mainCtx as never, { querySource: 'sdk' }).length === 0, j(mainDrained))
  advisor.stashAdvisorNote(SESSION, note as never)
  storage.saveAdvisorSwitch(false)
  check("/advise off landing while a note is stashed stops its delivery without destroying it (red on the base: the drain consumed the stash before reading the switch, so the note was lost — the Heroes 3 session's 00:05 mdfind note, recorded in the advisor's memory, never reached the agent)", getAdvisorNoteAttachments(mainCtx as never, { querySource: 'sdk' }).length === 0 && advisor.peekAdvisorNotes(SESSION).length === 1, j(advisor.peekAdvisorNotes(SESSION)))
  storage.saveAdvisorSwitch(true)
  const redelivered = getAdvisorNoteAttachments(mainCtx as never, { querySource: 'sdk' }) as Raw[]
  check('…and once the chat is advised again the held note is delivered intact', redelivered.length === 1 && redelivered[0]!.prompt === note.text && advisor.peekAdvisorNotes(SESSION).length === 0, j(redelivered))
  ctx.agentKind = 'crewmate'
  const { createSubagentContext } = await import(join(ROOT, 'src/crew/agents/forkedAgent.ts'))
  const fork = createSubagentContext(ctx as never)
  check('a crewmate context fork retains the crewmate exclusion', fork.agentKind === 'crewmate', 'change createSubagentContext in src/crew/agents/forkedAgent.ts to carry agentKind into the fork')
  const forkDenied = await AskAdvisorTool.call({ question: QUESTION }, fork) as { data: { status: string; text: string } }
  check('a crewmate fork cannot call AskAdvisor through a stale tool', forkDenied.data.status === 'refused' && wire.length === before && forkDenied.data.text.includes(advisor.ADVISOR_CREWMATE_REFUSAL), j(forkDenied))
}

server.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} advisor roads: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
