#!/usr/bin/env bun
// gate-watch: src/services/compact/autoCompact.ts src/run-core/turn-machine.ts src/utils/model/capabilities.ts src/services/providers/local/localWindow.ts src/services/providers/local/localCallModel.ts src/utils/contextFill.ts src/utils/cockpit/modelGauge.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'ANTHROPIC_API_KEY', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_CTX_COMPACTION', 'MERCURY_THINKING_BUDGET', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[key]
const base = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const proofHome = mkdtempSync(join(base, 'local-window-one-truth-'))
process.env.MERCURY_CONFIG_DIR = proofHome
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (line: string): void => console.log(`  [record] ${line}`)
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const fmt = (n: number): string => n.toLocaleString('en-US')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the local-window one-truth prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const CODER = 'qwen2.5-coder:3b'
const TINY = 'tiny-4k:latest'
const SERVED_DEFAULT = 4096
const CODER_TRAINED_MAX = 131072
const loaded = new Map<string, number>([[CODER, SERVED_DEFAULT], [TINY, SERVED_DEFAULT]])
const chats: Array<{ model: string; numCtx: number | undefined; chars: number }> = []
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = await new Promise<{ server: Server; root: string }>(resolve => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      if (url === '/api/tags') return json(res, 200, { models: [CODER, TINY].map(name => ({ name, model: name, size: 1_900_000_000, details: { family: 'qwen2', parameter_size: '3B', quantization_level: 'Q4_K_M' } })) })
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/ps') return json(res, 200, { models: [...loaded.entries()].map(([name, ctx]) => ({ name, model: name, size: 1_900_000_000, context_length: ctx, expires_at: '2026-01-01T00:00:00Z' })) })
      if (url === '/api/show') {
        const id = String(body.model ?? '')
        const max = id === TINY ? SERVED_DEFAULT : CODER_TRAINED_MAX
        return json(res, 200, { modelfile: '', parameters: `num_ctx                        ${SERVED_DEFAULT}`, details: {}, model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': max }, capabilities: ['completion', 'tools'] })
      }
      if (url === '/api/generate') {
        const options = body.options as { num_ctx?: number } | undefined
        loaded.set(String(body.model ?? ''), options?.num_ctx ?? SERVED_DEFAULT)
        return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' })
      }
      if (url === '/api/chat') {
        const options = body.options as { num_ctx?: number } | undefined
        const model = String(body.model ?? '')
        loaded.set(model, options?.num_ctx ?? SERVED_DEFAULT)
        chats.push({ model, numCtx: options?.num_ctx, chars: raw.length })
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'ok.' }, done: false })}\n`)
        res.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(raw.length / 4), eval_count: 2 })}\n`)
        res.end()
        return
      }
      json(res, 404, { error: 'not found' })
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    resolve({ server, root: `http://127.0.0.1:${port}` })
  })
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setAskChannel('none')
const { resolveContextWindow, getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { getBlockingLimit, calculateTokenWarningState, MANUAL_COMPACT_BUFFER_TOKENS } = await import('../../src/services/compact/autoCompact.ts')
const { contextFillView } = await import('../../src/utils/contextFill.ts')
const { modelGauge } = await import('../../src/utils/cockpit/modelGauge.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const w = await import('../../src/services/providers/local/localWindow.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { queryEvents } = await import('../../src/query.ts')
const { legacyYieldsOf } = await import('../../src/run-core/project-legacy.ts')
const { estimateOverflowSignal } = await import('../../src/services/api/overflowSignal.ts')
const { overflowRefusalText } = await import('../../src/services/compact/overflowRecovery.ts')
type Message = import('../../src/types/message.ts').Message

await refreshLocalDiscovery({ force: true })
const coder = localRecordFor(`local/${CODER}`)!
const tiny = localRecordFor(`local/${TINY}`)!
const CODER_MODEL = `local/${CODER}`
const TINY_MODEL = `local/${TINY}`

const limitOn = (model: string, window: number): number => window - Math.min(getModelMaxOutputTokens(model).upperLimit, 20_000, Math.floor(window / 4)) - MANUAL_COMPACT_BUFFER_TOKENS

async function sendOne(model: string, text: string): Promise<{ numCtx: number | undefined; errors: string[] }> {
  const before = chats.length
  const errors: string[] = []
  for await (const item of localCallModel({
    messages: [createUserMessage({ content: text })] as never,
    systemPrompt: ['You are a fixture session.'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model, querySource: 'user', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    const row = item as { isApiErrorMessage?: boolean; message?: { content?: Array<{ type?: string; text?: string }> } }
    if (row.isApiErrorMessage === true) errors.push((row.message?.content ?? []).map(b => b.text ?? '').join(''))
  }
  return { numCtx: chats[before]?.numCtx, errors }
}

section('§1 the pre-flight limit reads the window Mercury sends: a 4,096 served model with the Local model window set to 32k budgets 32,768, not the server\'s 4,096')
{
  w.__resetLocalWindowsForTest()
  w.writeLocalWindowSetting(coder, 32768)
  check('discovery states the served window (4,096 · served) and the trained maximum (131,072)', coder.contextWindow?.tokens === SERVED_DEFAULT && coder.contextWindow.source === 'served' && coder.modelMaxContext === CODER_TRAINED_MAX, JSON.stringify({ window: coder.contextWindow, max: coder.modelMaxContext }))
  const resolution = resolveContextWindow(CODER_MODEL)
  record(`the window resolves to ${fmt(resolution.effectiveWindow)} (${resolution.source}${resolution.fallbackReason ? `; ${resolution.fallbackReason}` : ''}); the base read the served 4,096 and its limit was ${fmt(limitOn(CODER_MODEL, SERVED_DEFAULT))}`)
  check('the context window is the window Mercury will send (32,768), live-current, the note naming the setting', resolution.effectiveWindow === 32768 && resolution.source === 'live-current' && (resolution.fallbackReason ?? '').includes('your setting — /config → Local model window'), JSON.stringify(resolution))
  const limit = getBlockingLimit(CODER_MODEL)
  check(`the blocking limit is the 32k window's own arithmetic (${fmt(limitOn(CODER_MODEL, 32768))}), never 72 (red on the base: 4,096 − 1,024 − 3,000)`, limit === limitOn(CODER_MODEL, 32768) && limit > 10_000, String(limit))
  const level = calculateTokenWarningState(1904, CODER_MODEL).level
  check("the tester's 1,904-token estimate is not blocked", level === 'ok', level)
  const stale = overflowRefusalText(estimateOverflowSignal({ family: 'local', actualTokens: 1904, limitTokens: limitOn(CODER_MODEL, SERVED_DEFAULT) }), 'single-message', { nonInteractive: true })
  record(`the sentence the tester saw on the base: ${stale}`)
}

section('§2 one window: the request\'s num_ctx equals the limit\'s window, the gauge agrees, and after the turn the server holds the model at it')
{
  const messages = [createUserMessage({ content: 'hello' })] as Message[]
  const fill = contextFillView(messages, CODER_MODEL)
  const gauge = modelGauge(CODER_MODEL)
  check('the context gauge and the model gauge read 32,768 before any request', fill.window === 32768 && gauge.data.window === 32768, JSON.stringify({ fill: fill.window, gauge: gauge.data.window }))
  const sent = await sendOne(CODER_MODEL, 'hello')
  check('the request carried num_ctx 32768 and was answered (no refusal)', sent.numCtx === 32768 && sent.errors.length === 0, JSON.stringify(sent))
  check('the hold is 32,768 (your setting) and the server now serves the model at it', w.heldLocalWindow(coder)?.window === 32768 && w.heldLocalWindow(coder)?.reason === 'set' && coder.contextWindow?.tokens === 32768 && coder.contextWindow.source === 'served', JSON.stringify({ hold: w.heldLocalWindow(coder)?.window, served: coder.contextWindow }))
  check('the limit, the gauge and the request still agree after the turn', getBlockingLimit(CODER_MODEL) === limitOn(CODER_MODEL, 32768) && contextFillView(messages, CODER_MODEL).window === 32768, String(getBlockingLimit(CODER_MODEL)))
}

section('§3 a window change takes effect without a restart: /config → 64k moves the limit and the gauge at once, the next request carries it; server default reads the served figure; auto reads the decision')
{
  const epochBefore = catalogueEpoch()
  w.writeLocalWindowSetting(coder, 65536)
  check('the setting write bumps the catalogue epoch (the gauge repaints)', catalogueEpoch() > epochBefore, `${epochBefore} → ${catalogueEpoch()}`)
  check('the limit reads the 64k window before any request (the stale 32k hold is not read)', getBlockingLimit(CODER_MODEL) === limitOn(CODER_MODEL, 65536) && resolveContextWindow(CODER_MODEL).effectiveWindow === 65536, String(getBlockingLimit(CODER_MODEL)))
  check('the gauge reads 65,536 at once', contextFillView([createUserMessage({ content: 'hello' })] as Message[], CODER_MODEL).window === 65536)
  const sent = await sendOne(CODER_MODEL, 'hello again')
  check('the next request carried num_ctx 65536 (the hold re-decided on the new setting)', sent.numCtx === 65536 && w.heldLocalWindow(coder)?.window === 65536, JSON.stringify(sent))
  w.writeLocalWindowSetting(coder, 'server')
  check('server default: the limit reads the window the server holds the model at (65,536 served after the reload)', coder.contextWindow?.tokens === 65536 && resolveContextWindow(CODER_MODEL).effectiveWindow === 65536 && resolveContextWindow(CODER_MODEL).fallbackReason === undefined, JSON.stringify(resolveContextWindow(CODER_MODEL)))
  w.writeLocalWindowSetting(coder, undefined)
  const auto = resolveContextWindow(CODER_MODEL)
  record(`auto, no hold for it yet, the machine unread: the window resolves to ${fmt(auto.effectiveWindow)} (${auto.fallbackReason ?? auto.source})`)
  check('auto with no setting: the limit reads the decision Mercury will make (the trained max 131,072 on an unread machine), named as chosen by Mercury', auto.effectiveWindow === CODER_TRAINED_MAX && (auto.fallbackReason ?? '').includes('chosen by Mercury for this session (auto)') && getBlockingLimit(CODER_MODEL) === limitOn(CODER_MODEL, CODER_TRAINED_MAX), JSON.stringify(auto))
  const sentAuto = await sendOne(CODER_MODEL, 'and again')
  check('the auto request carried num_ctx 131072 — the same window the limit read', sentAuto.numCtx === CODER_TRAINED_MAX && w.heldLocalWindow(coder)?.window === CODER_TRAINED_MAX && getBlockingLimit(CODER_MODEL) === limitOn(CODER_MODEL, CODER_TRAINED_MAX), JSON.stringify(sentAuto))
}

section('§4 a 13,761-token system prompt against a true 4,096 model: the turn refuses with the real numbers (the prompt\'s estimate against the chosen window) and the window remedy, never "1,904 > 72"')
{
  w.__resetLocalWindowsForTest()
  w.writeLocalWindowSetting(tiny, 32768)
  check('the tiny model: served 4,096, trained maximum 4,096, so the 32k setting clamps to 4,096 and the limit is the base\'s 72', tiny.modelMaxContext === SERVED_DEFAULT && resolveContextWindow(TINY_MODEL).effectiveWindow === SERVED_DEFAULT && getBlockingLimit(TINY_MODEL) === limitOn(TINY_MODEL, SERVED_DEFAULT), JSON.stringify({ window: resolveContextWindow(TINY_MODEL).effectiveWindow, limit: getBlockingLimit(TINY_MODEL) }))
  const systemPrompt = ['the system prompt of this session. '.repeat(1_573)]
  const systemTokens = Math.ceil(JSON.stringify(systemPrompt).length / 4)
  const ask = createUserMessage({ content: 'please summarise the repository layout. '.repeat(190) })
  const askTokens = tokenCountWithEstimation([ask] as never)
  record(`the system prompt alone is ≈${fmt(systemTokens)} tokens; the operator's message ≈${fmt(askTokens)} tokens by the pre-flight's count`)
  const makeTool = (name: string): never =>
    ({
      name,
      async description() {
        return 'rig tool'
      },
      async prompt() {
        return 'rig tool'
      },
      inputSchema: z.object({ text: z.string().optional() }),
      userFacingName: () => name,
      isEnabled: () => true,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isMcp: false,
      needsPermissions: () => false,
      async validateInput() {
        return { result: true }
      },
      call: async () => ({ data: 'rig' }),
      mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
    }) as never
  async function runTurn(model: string): Promise<{ terminal: Record<string, unknown>; calls: number; errors: string[] }> {
    let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
    const ctx = {
      abortController: new AbortController(),
      options: { commands: [], tools: [makeTool('EchoTool')], engineModel: model, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
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
    let calls = 0
    async function* callModel(): AsyncGenerator<never, void> {
      calls++
      yield createAssistantMessage({ content: 'answered' }) as never
    }
    let n = 0
    const gen = queryEvents({
      messages: [ask] as never,
      systemPrompt: systemPrompt as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      deps: { callModel: callModel as never, autocompact: (async () => ({ wasCompacted: false })) as never, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` } as never,
    })
    const errors: string[] = []
    let r = await gen.next()
    while (!r.done) {
      for (const y of legacyYieldsOf(r.value as never)) {
        const row = y as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
        if (row.type === 'assistant' && row.isApiErrorMessage === true) {
          const c = row.message?.content
          errors.push(typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ text?: string }>).map(b => b.text ?? '').join('') : '')
        }
      }
      r = await gen.next()
    }
    return { terminal: r.value as Record<string, unknown>, calls, errors }
  }
  const refused = await runTurn(TINY_MODEL)
  const text = refused.errors[0] ?? ''
  record(`the refusal: ${text}`)
  check('the turn stopped before the call (terminal blocking_limit, zero model calls, one error row)', refused.terminal.reason === 'blocking_limit' && refused.calls === 0 && refused.errors.length === 1, JSON.stringify(refused.terminal))
  check('the row names the real prompt estimate (≈16k tokens: the 13.7k system prompt, the message and the tool schema) against the chosen window (4096 tokens) — not "estimated 1,9xx tokens > 72"', /the composed request \(≈1[5-7]k tokens, 1 tool schemas included\) cannot fit 'tiny-4k:latest's served context window \(4096 tokens — /.test(text) && !text.includes('> 72') && !text.includes('this message alone'), text)
  check('the remedy names the Local model window road and a larger-window local model', text.includes('/config → Local model window') && text.includes('or pick a larger-window local model'), text)
  w.writeLocalWindowSetting(coder, 32768)
  const served = await runTurn(CODER_MODEL)
  check("the tester's case on the 32k-set model: the same prompt passes the pre-flight and reaches the model (terminal completed, one call, no error row) — red on the base: blocking_limit at 72", served.terminal.reason === 'completed' && served.calls === 1 && served.errors.length === 0, JSON.stringify({ terminal: served.terminal, errors: served.errors }))
}

section('§5 the headless road (mercury run --format rows): a model ALREADY RESIDENT at 4,096 with a 13.7k prompt and a 32k setting proceeds at 32,768 and completes; a true 4k model fails with the local sentence, never "nothing more could be pruned — /compact"')
{
  const { Conversation } = await import('../../src/rows/turn.ts')
  const { exitCodeOf } = await import('../../src/rows/vocabulary.ts')
  const { refreshLocalDiscovery: reprobe } = await import('../../src/services/providers/local/localDiscovery.ts')
  bootstrap.setSessionPersistenceDisabled(true)
  loaded.set(CODER, SERVED_DEFAULT)
  loaded.set(TINY, SERVED_DEFAULT)
  w.__resetLocalWindowsForTest()
  await reprobe({ force: true })
  const resident = localRecordFor(CODER_MODEL)!
  check('the model is resident at 4,096 (the tester\'s curl /api/generate with num_ctx 4096 before the run)', resident.contextWindow?.tokens === SERVED_DEFAULT && resident.contextWindow.source === 'served' && resident.loaded === true, JSON.stringify(resident.contextWindow))
  w.writeLocalWindowSetting(resident, 32768)
  const customSystemPrompt = 'the system prompt of this session. '.repeat(1_573)
  async function headless(model: string, prompt: string): Promise<{ outcome: Record<string, unknown> | undefined; chat: { numCtx: number | undefined } | undefined }> {
    let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
    const conversation = new Conversation({
      cwd: proofHome,
      tools: [] as never,
      commands: [],
      mcpClients: [],
      agents: { activeAgents: [], allAgents: [] } as never,
      canUseTool: (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
      getAppState: () => appState as never,
      setAppState: ((f: (prev: never) => never): void => {
        appState = f(appState as never) as unknown as Record<string, unknown>
      }) as never,
      readFileState: createFileStateCacheWithSizeLimit(100),
      customSystemPrompt,
      userSpecifiedModel: model,
      thinkingConfig: { type: 'disabled' } as never,
      maxTurns: 1,
    })
    const before = chats.length
    let outcome: Record<string, unknown> | undefined
    for await (const row of conversation.turn(prompt)) {
      const draft = row as unknown as Record<string, unknown>
      if (draft.type === 'outcome') outcome = draft
    }
    return { outcome, chat: chats[before] }
  }
  const testerPrompt = 'Create a file hello.py that prints a greeting. '.repeat(170)
  record(`the tester's prompt ≈${fmt(tokenCountWithEstimation([createUserMessage({ content: testerPrompt })] as never))} tokens by the pre-flight's count (the log line read tokens=2012 against threshold=18, effectiveWindow=3072)`)
  const ran = await headless(CODER_MODEL, testerPrompt)
  record(`resident 4,096 · 32k set: outcome ${JSON.stringify(ran.outcome?.status)} ${JSON.stringify((ran.outcome?.error as { class?: string } | undefined)?.class ?? '')} · the request's num_ctx ${String(ran.chat?.numCtx)}`)
  check('the run completes (exit 0): the pre-flight read the 32k window, the request went out at num_ctx 32768 (the resident 4,096 was not adopted) — red on the base: failed / context_limit after the pre-flight read 4,096 (effectiveWindow 3,072, threshold 18)', ran.outcome?.status === 'completed' && exitCodeOf(ran.outcome.status as never) === 0 && ran.chat?.numCtx === 32768 && w.heldLocalWindow(resident)?.window === 32768 && w.heldLocalWindow(resident)?.adopted === undefined, JSON.stringify({ outcome: ran.outcome, chat: ran.chat, hold: w.heldLocalWindow(resident) }))
  const tinyResident = localRecordFor(TINY_MODEL)!
  w.writeLocalWindowSetting(tinyResident, 32768)
  const failed = await headless(TINY_MODEL, testerPrompt)
  const error = failed.outcome?.error as { message?: string; class?: string } | undefined
  record(`true 4k model, the tester's prompt (the pre-flight blocks): outcome ${JSON.stringify(failed.outcome?.status)} · ${JSON.stringify(error)}`)
  const localSentence = (text: string | undefined): boolean => /the composed request \(≈1[4-9]k tokens, 0 tool schemas included\) cannot fit 'tiny-4k:latest's served context window \(4096 tokens — /.test(text ?? '') && (text ?? '').includes('/config → Local model window')
  check('the run fails (exit 1) with the class context_limit and the LOCAL sentence: the composed request against the 4096-token window and the window remedy', failed.outcome?.status === 'failed' && error?.class === 'context_limit' && localSentence(error.message), JSON.stringify(error))
  check('…never the generic "nothing more could be pruned — /compact or a fresh session makes room", and no request reached the server', !(error?.message ?? '').includes('nothing more could be pruned') && failed.chat === undefined, JSON.stringify({ message: error?.message, chat: failed.chat }))
  const short = await headless(TINY_MODEL, 'Create a file hello.py that prints a greeting.')
  const shortError = short.outcome?.error as { message?: string; class?: string } | undefined
  record(`true 4k model, a short prompt (the request road's guard refuses): outcome ${JSON.stringify(short.outcome?.status)} · class ${JSON.stringify(shortError?.class)}`)
  check('a short prompt reaches the request road and its guard refuses with the same sentence and the same class, before any send', short.outcome?.status === 'failed' && shortError?.class === 'context_limit' && localSentence(shortError.message) && short.chat === undefined, JSON.stringify(shortError))
  bootstrap.setSessionPersistenceDisabled(false)
}

ollama.server.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
