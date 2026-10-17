#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'reasoning-only-nudge-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'reasoning-only-nudge-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_TIME_BASED_MC', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_THINKING_BINDING', 'MERCURY_PREFIX_INDUCE_EDIT', 'NODE_ENV', 'ANTHROPIC_BASE_URL']) {
  delete process.env[k]
}

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the reasoning-only nudge prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolvePromise => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (model: unknown, delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })
const usageFrame = (model: unknown): string =>
  sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } })

const LOCAL_MODEL_ID = 'Qwen/Qwen3-32B'
const VLLM_MODELS = { object: 'list', data: [{ id: LOCAL_MODEL_ID, object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] }
const THOUGHT = 'Done — the menu file is updated and the footer is aligned.'
const LOCAL_REPLY = 'The menu file is updated and the footer is aligned.'
const CLOUD_REPLY = 'A quick demo: one HTML file with a canvas and a loop.'
const ASK = 'a quick demo of the game in html'
const BASE_WORDS = 'your last turn carried thinking only — say your reply, or call the tool you meant'
const FEWER_WORDS = 'you ran out of output while thinking — answer in fewer words'
const CLOUD_MODEL = 'claude-opus-4-8'
const CUT_THOUGHT_DELTAS = ['The user wants a quick demo of the game', ' in HTML — I will design the whole engine first']
const CUT_THOUGHT = CUT_THOUGHT_DELTAS.join('')

type ChatAnswer = (model: unknown, res: ServerResponse) => void
const reasoningOnlyStop: ChatAnswer = (model, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunk(model, { role: 'assistant', reasoning: THOUGHT }))
  res.write(chunk(model, {}, 'stop'))
  res.write(usageFrame(model))
  res.write('data: [DONE]\n\n')
  res.end()
}
const reasoningThenReply: ChatAnswer = (model, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunk(model, { role: 'assistant', reasoning: 'short thought' }))
  res.write(chunk(model, { content: LOCAL_REPLY }, 'stop'))
  res.write(usageFrame(model))
  res.write('data: [DONE]\n\n')
  res.end()
}

type WireBody = { messages: Array<{ role: string; content: unknown }>; reasoning_effort?: unknown }
const localBodies: WireBody[] = []
let localScript: ChatAnswer[] = []
const vllm = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/v1/models') return json(res, 200, VLLM_MODELS)
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    const parsed = JSON.parse(body || '{}') as WireBody & { model?: unknown }
    localBodies.push(parsed)
    const answer = localScript.shift()
    if (!answer) return json(res, 500, { error: 'fixture script exhausted' })
    answer(parsed.model, res)
    return true
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `vllm=${vllm.root}`

const turnMachine = (await import('../../src/run-core/turn-machine.ts')) as Record<string, unknown>
const runEventCore = turnMachine.runEventCore as (params: unknown, consumed: string[]) => AsyncGenerator<Record<string, unknown>, Record<string, unknown>>
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const errors = (await import('../../src/services/api/errors.ts')) as Record<string, unknown>
const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
await refreshLocalDiscovery({ force: true })
const LOCAL_MODEL = `local/${LOCAL_MODEL_ID}`
const CEILING = getModelMaxOutputTokens(CLOUD_MODEL).default
const CEILING_WORDS = CEILING % 1000 === 0 ? `${CEILING / 1000}k` : String(CEILING)
const MARKER = errors.REASONING_CUT_MARKER as string | undefined

type AnyMsg = Record<string, unknown> & { type?: string; isApiErrorMessage?: boolean; isMeta?: boolean; message?: { role?: string; content?: unknown; stop_reason?: string } }
type CallRecord = { messages: AnyMsg[] }
type Run = {
  calls: CallRecord[]
  notices: Array<{ text: string; level: string; subtype: string }>
  transitions: Array<{ reason: string; attempt?: number }>
  efforts: unknown[]
  answers: string[]
  withheldSurfaced: number
  terminal: Record<string, unknown>
}

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) },
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: `echo:${(input?.text as string) ?? ''}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}

function makeCtx(model: string, effortValue: string, thinkingConfig: Record<string, unknown>, tools: unknown[] = []): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools,
      engineModel: model,
      thinkingConfig,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

async function run(road: (params: { messages: AnyMsg[] }) => AsyncGenerator<unknown, void>, ctx: Record<string, unknown>): Promise<Run> {
  const calls: CallRecord[] = []
  async function* callModel(params: { messages: AnyMsg[] }): AsyncGenerator<unknown, void> {
    calls.push({ messages: [...params.messages] })
    yield* road(params)
  }
  const gen = runEventCore(
    {
      messages: [createUserMessage({ content: ASK })],
      systemPrompt: ['rig system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: ctx,
      querySource: 'sdk',
      deps: {
        callModel,
        autocompact: async () => ({ wasCompacted: false }),
        microcompact: async (messages: unknown[]) => ({ messages }),
        uuid: (() => {
          let n = 0
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        })(),
      },
    },
    [],
  )
  const out: Run = { calls, notices: [], transitions: [], efforts: [], answers: [], withheldSurfaced: 0, terminal: {} }
  let r = await gen.next()
  while (!r.done) {
    const e = r.value
    if (e.kind === 'notice') {
      const m = e.message as { content?: unknown; level?: unknown; subtype?: unknown }
      out.notices.push({ text: String(m.content ?? ''), level: String(m.level ?? ''), subtype: String(m.subtype ?? '') })
    }
    if (e.kind === 'turn_settled') out.transitions.push(e.transition as { reason: string; attempt?: number })
    if (e.kind === 'model_call_started') out.efforts.push(e.effort)
    if (e.kind === 'withheld_surfaced') out.withheldSurfaced++
    if (e.kind === 'assistant_settled' && e.withheld !== true) {
      const content = (e.message as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const b of content as AnyMsg[]) if (b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim() !== '') out.answers.push(b.text as string)
      }
    }
    r = await gen.next()
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  out.terminal = r.value
  return out
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}
const lastUser = (msgs: AnyMsg[]): AnyMsg | undefined => [...msgs].reverse().find(m => m.type === 'user')
const reasoningTransitions = (r: Run): Array<{ reason: string; attempt?: number }> => r.transitions.filter(t => t.reason === 'reasoning_only_recovery')
const maxTokensTransitions = (r: Run): number => r.transitions.filter(t => t.reason === 'max_output_tokens_recovery').length
const warnings = (r: Run, needle: string): number => r.notices.filter(n => n.level === 'warning' && n.text.includes(needle)).length

const runLocal = (answers: ChatAnswer[], effortValue = 'high'): Promise<Run> => {
  localScript = [...answers]
  return run(params => localCallModel(params as never) as never, makeCtx(LOCAL_MODEL, effortValue, { type: 'enabled', budget_tokens: 1024 }))
}

section('0 · the owners: the words live beside the other nudges, the decision is pure, the ceiling is the catalogue\'s')
{
  const nudge = errors.reasoningOnlyRecoveryNudge as ((fewerWords: boolean) => string) | undefined
  check('reasoningOnlyRecoveryNudge is exported from services/api/errors.ts', typeof nudge === 'function', 'not exported')
  check('the plain words: ' + j(BASE_WORDS), typeof nudge === 'function' && nudge(false).includes(BASE_WORDS) && !nudge(false).includes(FEWER_WORDS), typeof nudge === 'function' ? nudge(false) : '')
  check('the fewer-words variant adds: ' + j(FEWER_WORDS), typeof nudge === 'function' && nudge(true).includes(BASE_WORDS) && nudge(true).includes(FEWER_WORDS), typeof nudge === 'function' ? nudge(true) : '')
  const isNudge = errors.isReasoningOnlyRecoveryNudgeText as ((text: string) => boolean) | undefined
  check('the classifier accepts both wordings and nothing else', typeof isNudge === 'function' && typeof nudge === 'function' && isNudge(nudge(false)) && isNudge(nudge(true)) && !isNudge(ASK) && !isNudge(String(errors.EMPTY_REPLY_RECOVERY_NUDGE)), 'isReasoningOnlyRecoveryNudgeText missing or wrong')
  check('the cut marker (the text block that lets the truncated thinking ride the wire) is owned there too', typeof MARKER === 'string' && MARKER.startsWith('[') && MARKER.endsWith(']') && /output ran out/.test(MARKER), j(MARKER))
  const decide = turnMachine.decideReasoningOnlyRecovery as ((input: { recoveryCount: number; maxTokens: boolean }) => { kind: string; attempt?: number }) | undefined
  check('a plain thinking-only stop: one continuation, then surface', typeof decide === 'function' && decide({ recoveryCount: 0, maxTokens: false }).kind === 'continue' && decide({ recoveryCount: 0, maxTokens: false }).attempt === 1 && decide({ recoveryCount: 1, maxTokens: false }).kind === 'surface', 'not exported or wrong')
  check('a max-tokens thinking-only stop: two continuations, then surface', typeof decide === 'function' && decide({ recoveryCount: 0, maxTokens: true }).kind === 'continue' && decide({ recoveryCount: 1, maxTokens: true }).kind === 'continue' && decide({ recoveryCount: 1, maxTokens: true }).attempt === 2 && decide({ recoveryCount: 2, maxTokens: true }).kind === 'surface', 'not exported or wrong')
  const transitions = readFileSync(resolve(ROOT, 'src/query/transitions.ts'), 'utf8')
  check('the transition reason is typed in query/transitions.ts', transitions.includes("reason: 'reasoning_only_recovery'; attempt: number"))
  const ceilings = [LOCAL_MODEL, CLOUD_MODEL].map(model => getModelMaxOutputTokens(model).default)
  check('the row fixtures have different catalogue ceilings, so a literal cannot satisfy both', new Set(ceilings).size === 2, j(ceilings))
  for (const model of [LOCAL_MODEL, CLOUD_MODEL]) {
    let calls = 0
    const r = await run(async function* () {
      const cut = calls++ === 0
      const message = createAssistantMessage({ content: cut ? [{ type: 'thinking', thinking: THOUGHT, signature: 'fixture-signature' }] as never : 'reply' }) as unknown as AnyMsg
      ;(message.message as { stop_reason: string }).stop_reason = cut ? 'max_tokens' : 'end_turn'
      yield message
    }, makeCtx(model, 'high', { type: 'disabled' }))
    const ceiling = getModelMaxOutputTokens(model).default
    const words = ceiling % 1000 === 0 ? `${ceiling / 1000}k` : String(ceiling)
    check(`the emitted row reads the catalogue ceiling (${words}) for ${model}, independent of published source comments`, warnings(r, `thinking ran to the output limit (${words}) — continuing`) === 1 && r.calls.length === 2 && r.answers.at(-1) === 'reply', j(r.notices))
  }
}

section('A · the local road: a turn of thinking only (no text, no tool call, end_turn) gets ONE continuation and the reply lands as text')
{
  check('the fixture model is a discovered local record', localRecordFor(LOCAL_MODEL) !== undefined)
  const r = await runLocal([reasoningOnlyStop, reasoningThenReply])
  check('two chat requests (the thinking-only turn, then the continuation)', r.calls.length === 2 && localBodies.length === 2, `${r.calls.length} call(s), ${localBodies.length} body(ies)`)
  check('the run completed', r.terminal.reason === 'completed', j(r.terminal))
  check('the reply lands as text', r.answers.at(-1) === LOCAL_REPLY, j(r.answers))
  check('exactly one reasoning_only_recovery transition, attempt 1', reasoningTransitions(r).length === 1 && reasoningTransitions(r)[0]?.attempt === 1, j(r.transitions))
  const continuation = r.calls[1]?.messages ?? []
  const nudge = continuation.at(-1)
  check('the continuation ends with an isMeta user message carrying the words', nudge?.type === 'user' && nudge.isMeta === true && textOf(nudge.message?.content).includes(BASE_WORDS), j(textOf(nudge?.message?.content)).slice(0, 200))
  check('the plain words carry no fewer-words clause (the turn stopped on its own)', nudge !== undefined && !textOf(nudge.message?.content).includes(FEWER_WORDS))
  check('the thinking-only assistant message stands directly above the nudge (the model sees what it did)', continuation.at(-2)?.type === 'assistant' && Array.isArray(continuation.at(-2)?.message?.content) && (continuation.at(-2)?.message?.content as AnyMsg[]).every(b => b.type === 'thinking'), String(continuation.at(-2)?.type))
  check('no API-error row rides the continuation', !continuation.some(m => m.type === 'assistant' && m.isApiErrorMessage === true))
  const wire = localBodies[1]?.messages ?? []
  const wireLast = wire.at(-1)
  check('the wire body: the last row is the user nudge with the words', wireLast?.role === 'user' && String(wireLast.content).includes(BASE_WORDS), `${String(wireLast?.role)}: ${j(String(wireLast?.content ?? '').slice(0, 120))}`)
  check('one visible warning row says the turn carried thinking only and the model was asked once', warnings(r, 'carried thinking only') === 1, j(r.notices))
  check('the effort is the session\'s on both requests', r.efforts.length === 2 && r.efforts[0] === 'high' && r.efforts[1] === 'high', j(r.efforts))
}

section('B · the local road: two thinking-only turns in a row — the turn ends with the plain words, no third request')
{
  const before = localBodies.length
  const r = await runLocal([reasoningOnlyStop, reasoningOnlyStop, reasoningThenReply])
  check('exactly two chat requests', r.calls.length === 2 && localBodies.length - before === 2, `${r.calls.length} call(s)`)
  check('the run completed (as today, no error)', r.terminal.reason === 'completed', j(r.terminal))
  check('one continuation only', reasoningTransitions(r).length === 1, j(r.transitions))
  check('the plain words end the turn: "carried thinking only again — the turn ends here"', warnings(r, 'carried thinking only again — the turn ends here') === 1, j(r.notices))
  check('no text landed (nothing to show)', r.answers.length === 0, j(r.answers))
}

section('C · the local road control: a turn with text gets no nudge')
{
  const r = await runLocal([reasoningThenReply])
  check('one request, no continuation, the reply lands', r.calls.length === 1 && reasoningTransitions(r).length === 0 && r.answers.at(-1) === LOCAL_REPLY, `${r.calls.length} call(s) ${j(r.transitions)}`)
}

type Block = { type?: string; text?: string; thinking?: string; signature?: string }
type Body = { output_config?: { effort?: unknown }; messages?: Array<{ role: string; content: unknown }> }
const maxTokensThinking: ScriptedTurn = { kind: 'stream', blocks: [{ type: 'thinking', deltas: CUT_THOUGHT_DELTAS }], gapMs: 1, stopReason: 'max_tokens', usage: { output_tokens: CEILING } }
const cloudReply: ScriptedTurn = { kind: 'text', text: CLOUD_REPLY, thinking: 'a short thought', model: CLOUD_MODEL }
const runCloud = async (turns: ScriptedTurn[], effortValue = 'max'): Promise<{ r: Run; bodies: Body[]; refusals: string[] }> => {
  const fixture = await startFixtureApi(turns, { apiChecks: true })
  process.env.ANTHROPIC_BASE_URL = fixture.url
  try {
    const r = await run(params => queryModelWithStreaming(params as never) as never, makeCtx(CLOUD_MODEL, effortValue, { type: 'adaptive' }))
    return { r, bodies: fixture.messageRequests().map(q => q.body as Body), refusals: fixture.refusals.map(f => f.message) }
  } finally {
    delete process.env.ANTHROPIC_BASE_URL
    await fixture.close()
  }
}
const assistantRows = (body: Body | undefined): Block[][] => (body?.messages ?? []).filter(m => m.role === 'assistant').map(m => (Array.isArray(m.content) ? (m.content as Block[]) : []))
const carriesCutThinking = (row: Block[]): boolean =>
  row.length === 2 && row[0]?.type === 'thinking' && row[0].thinking === CUT_THOUGHT && row[0].signature === 'fixture-signature' && row[1]?.type === 'text' && row[1].text === MARKER

section(`D · the Anthropic road: thinking ran to max_tokens with no text — one continuation at the SAME effort, the signed thinking carried as the assistant prefix, a visible row`)
{
  const { r, bodies, refusals } = await runCloud([maxTokensThinking, cloudReply])
  check('two message requests (the cut turn, then the continuation)', bodies.length === 2, `${bodies.length} request(s)`)
  check('the fixture refused nothing (the continuation is a legal request under the API\'s documented rules)', refusals.length === 0, j(refusals))
  check('the run completed and the reply landed as text', r.terminal.reason === 'completed' && r.answers.at(-1) === CLOUD_REPLY, `${j(r.terminal)} ${j(r.answers)}`)
  check('exactly one reasoning_only_recovery transition and NO max_output_tokens_recovery (the silent resume never fires)', reasoningTransitions(r).length === 1 && maxTokensTransitions(r) === 0, j(r.transitions))
  check('both requests rode at the same effort (max, max) — no rung drop', bodies[0]?.output_config?.effort === 'max' && bodies[1]?.output_config?.effort === 'max' && j(r.efforts) === j(['max', 'max']), `${j(bodies.map(b => b.output_config))} ${j(r.efforts)}`)
  const rows = assistantRows(bodies[1])
  const prefix = rows.at(-1)
  check('the continuation body carries the truncated turn\'s SIGNED thinking block, verbatim, as its last assistant row (followed only by the cut marker text)', prefix !== undefined && carriesCutThinking(prefix), j(prefix ?? null).slice(0, 300))
  const wireMessages = bodies[1]?.messages ?? []
  check('that assistant row stands directly before the user nudge (the prefix the model resumes from)', wireMessages.at(-2)?.role === 'assistant' && wireMessages.at(-1)?.role === 'user', j(wireMessages.map(m => m.role)))
  const last = wireMessages.at(-1)
  check('the first continuation\'s nudge carries the plain words and NOT "answer in fewer words"', last?.role === 'user' && textOf(last.content).includes(BASE_WORDS) && !textOf(last.content).includes(FEWER_WORDS), j(textOf(last?.content)).slice(0, 240))
  check(`the visible row: "thinking ran to the output limit (${CEILING_WORDS}) — continuing" at warning level`, warnings(r, `thinking ran to the output limit (${CEILING_WORDS}) — continuing`) === 1, j(r.notices))
  check('the withheld max-tokens error never surfaced (the continuation answered)', r.withheldSurfaced === 0, String(r.withheldSurfaced))
  const nudgeRow = lastUser(r.calls[1]?.messages ?? [])
  check('the nudge rides as an isMeta user message', nudgeRow?.isMeta === true && textOf(nudgeRow.message?.content).includes(BASE_WORDS))
}

section('E · the Anthropic road: a second max-tokens stop gets the second continuation, asking for fewer words; both truncated turns ride')
{
  const { r, bodies, refusals } = await runCloud([maxTokensThinking, maxTokensThinking, cloudReply])
  check('three message requests (the cut turn, two continuations)', bodies.length === 3, `${bodies.length} request(s)`)
  check('the fixture refused nothing', refusals.length === 0, j(refusals))
  check('the reply landed as text on the second continuation', r.terminal.reason === 'completed' && r.answers.at(-1) === CLOUD_REPLY, `${j(r.terminal)} ${j(r.answers)}`)
  check('two reasoning_only_recovery transitions (attempts 1 and 2) and no max_output_tokens_recovery', j(reasoningTransitions(r).map(t => t.attempt)) === j([1, 2]) && maxTokensTransitions(r) === 0, j(r.transitions))
  check('every request rode at max', bodies.every(b => b.output_config?.effort === 'max') && j(r.efforts) === j(['max', 'max', 'max']), j(r.efforts))
  const rows = assistantRows(bodies[2])
  check('the third request carries BOTH truncated turns\' signed thinking (two assistant rows, each thinking + the marker)', rows.length === 2 && rows.every(carriesCutThinking), j(rows).slice(0, 400))
  const last = bodies[2]?.messages?.at(-1)
  check('the second continuation\'s nudge adds "answer in fewer words"', last?.role === 'user' && textOf(last.content).includes(BASE_WORDS) && textOf(last.content).includes(FEWER_WORDS), j(textOf(last?.content)).slice(0, 240))
  const firstNudge = bodies[1]?.messages?.at(-1)
  check('the first continuation\'s nudge did not', firstNudge?.role === 'user' && !textOf(firstNudge.content).includes(FEWER_WORDS))
  check(`the second row: "thinking ran to the output limit (${CEILING_WORDS}) again — continuing, asking for fewer words"`, warnings(r, `thinking ran to the output limit (${CEILING_WORDS}) again — continuing, asking for fewer words`) === 1, j(r.notices))
}

section('F · the Anthropic road: a third max-tokens stop ends the turn with plain words — no third continuation, the operator decides')
{
  const { r, bodies } = await runCloud([maxTokensThinking, maxTokensThinking, maxTokensThinking, cloudReply])
  check('exactly three message requests (the cut turn and two continuations; no third continuation)', bodies.length === 3, `${bodies.length} request(s)`)
  check(`the plain words: "thinking ran to the output limit (${CEILING_WORDS}) again — the turn ends here after 2 continuations; the next step is yours"`, warnings(r, `thinking ran to the output limit (${CEILING_WORDS}) again — the turn ends here after 2 continuations; the next step is yours`) === 1, j(r.notices))
  check('the withheld max-tokens error surfaces once the continuations are spent', r.withheldSurfaced === 1, String(r.withheldSurfaced))
  check('no max_output_tokens_recovery transition; two reasoning_only_recovery', maxTokensTransitions(r) === 0 && reasoningTransitions(r).length === 2, j(r.transitions))
  check('the run completed', r.terminal.reason === 'completed', j(r.terminal))
}

section('G · the Anthropic road control: thinking followed by text gets no nudge and keeps its effort')
{
  const { r, bodies } = await runCloud([cloudReply])
  check('one request, no continuation, the reply lands, effort max', bodies.length === 1 && reasoningTransitions(r).length === 0 && r.answers.at(-1) === CLOUD_REPLY && bodies[0]?.output_config?.effort === 'max', `${bodies.length} request(s) ${j(r.transitions)} ${j(r.answers)}`)
}

section('H · the shape on a scripted road: a tool call after thinking is never nudged; a stream FAULT after thinking stays the stream-fault lane\'s; the native road\'s reasoningOnly stamp is read')
{
  const thinkingMessage = (): AnyMsg => {
    const m = createAssistantMessage({ content: [{ type: 'thinking', thinking: THOUGHT, signature: '' }] as never }) as unknown as AnyMsg
    ;(m.message as { stop_reason?: string }).stop_reason = 'end_turn'
    return m
  }
  const textMessage = (text: string): AnyMsg => {
    const m = createAssistantMessage({ content: text }) as unknown as AnyMsg
    ;(m.message as { stop_reason?: string }).stop_reason = 'end_turn'
    return m
  }
  const toolMessage = (id: string): AnyMsg => {
    const m = createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'EchoTool', input: { text: 'x' } }] as never }) as unknown as AnyMsg
    ;(m.message as { stop_reason?: string }).stop_reason = 'tool_use'
    return m
  }
  const scripted = (script: AnyMsg[][]): ((params: { messages: AnyMsg[] }) => AsyncGenerator<unknown, void>) => {
    let n = 0
    return async function* () {
      const steps = script[n++]
      if (!steps) throw new Error(`script exhausted at call ${n}`)
      for (const s of steps) yield s
    }
  }
  const toolCtx = makeCtx(CLOUD_MODEL, 'high', { type: 'disabled' }, [makeTool('EchoTool')])
  const withTool = await run(scripted([[thinkingMessage(), toolMessage('tu_1')], [textMessage('done')]]), toolCtx)
  check('thinking then a tool call: the tool round runs and no reasoning-only continuation fires', withTool.calls.length === 2 && reasoningTransitions(withTool).length === 0 && withTool.answers.at(-1) === 'done', `${withTool.calls.length} call(s) ${j(withTool.transitions)}`)
  const streamFaultAfterPartialText = errors.streamFaultAfterPartialText as (provider: string, code: string, message: string) => string
  const fault = createAssistantAPIErrorMessage({ content: streamFaultAfterPartialText('Fixture', 'no-finish', 'stream ended without finish'), error: 'server_error' } as never) as unknown as AnyMsg
  const faulted = await run(scripted([[thinkingMessage(), fault], [textMessage('after the cut')]]), makeCtx(CLOUD_MODEL, 'high', { type: 'disabled' }))
  const faultNudge = lastUser(faulted.calls[1]?.messages ?? [])
  check('a stream fault after thinking only takes the stream-fault continuation (its own nudge), never this one', faulted.calls.length === 2 && reasoningTransitions(faulted).length === 0 && faulted.transitions.some(t => t.reason === 'stream_fault_recovery') && faultNudge !== undefined && textOf(faultNudge.message?.content) === String(errors.STREAM_FAULT_RECOVERY_NUDGE), `${faulted.calls.length} call(s) ${j(faulted.transitions)} ${j(textOf(faultNudge?.message?.content)).slice(0, 120)}`)
  const stamped = thinkingMessage()
  stamped.reasoningOnly = true
  const viaStamp = await run(scripted([[stamped], [textMessage('the reply')]]), makeCtx(CLOUD_MODEL, 'high', { type: 'disabled' }))
  check('a message the transport stamped reasoningOnly: true is nudged once and the reply lands', viaStamp.calls.length === 2 && reasoningTransitions(viaStamp).length === 1 && viaStamp.answers.at(-1) === 'the reply', `${viaStamp.calls.length} call(s) ${j(viaStamp.transitions)}`)
  check('the effort stays the session\'s (high, high)', j(viaStamp.efforts) === j(['high', 'high']), j(viaStamp.efforts))
}

vllm.server.close()
clearTimeout(guard)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-reasoning-only-nudge: ALL GREEN' : `prove-reasoning-only-nudge: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
