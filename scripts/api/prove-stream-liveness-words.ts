import { createServer, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'liveness-words-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_RECONNECT_SCALE = '0.01'
process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0.025'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1000'
process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '400'
process.env.GEMINI_API_KEY = 'fixture-key-not-real'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
const guard = setTimeout(() => { console.error('liveness proof exceeded 90 s'); process.exit(1) }, 90_000)
guard.unref()
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail: unknown = '') => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${pass ? '' : ` — ${String(detail)}`}`)
}
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
let scenario: 'slow' | 'silent' | 'read' | 'recover' | 'tool' | 'cancel' = 'slow'
let hits = 0
const requests: unknown[] = []
const held = new Set<ServerResponse>()
const timers = new Set<ReturnType<typeof setTimeout>>()
const later = (fn: () => void, ms: number) => { const t = setTimeout(() => { timers.delete(t); fn() }, ms); timers.add(t) }
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const path = req.url ?? ''
    if (req.method !== 'POST') {
      if (path.startsWith('/metrics')) { res.end('llamacpp:prompt_tokens_seconds 3000\n'); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(path.startsWith('/props') ? { total_slots: 1, default_generation_settings: { n_ctx: 131072 } } : { models: [{ name: 'gemini-fixture' }], data: [] }))
      return
    }
    if (!path.includes(':streamGenerateContent') && !path.endsWith('/chat/completions') && !path.endsWith('/responses')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ models: { 'gemini-fixture': { model: 'gemini-fixture' } } }))
      return
    }
    hits++
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const gemini = path.includes(':streamGenerateContent')
    const responses = path.endsWith('/responses')
    const content = (text: string, thought = false) => gemini
      ? sse({ candidates: [{ content: { role: 'model', parts: [{ text, ...(thought ? { thought: true } : {}) }] } }] })
      : responses ? sse({ type: thought ? 'response.reasoning_text.delta' : 'response.output_text.delta', delta: text, item_id: 'fixture-message', output_index: 0, content_index: 0 })
      : sse({ choices: [{ delta: { [thought ? 'reasoning_content' : 'content']: text } }] })
    const end = () => res.end(gemini
      ? sse({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 } })
      : sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } }) + 'data: [DONE]\n\n')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    held.add(res)
    res.on('close', () => held.delete(res))
    if (scenario === 'slow') {
      later(() => { if (!res.destroyed) res.write(content('reasoning '.repeat(16), true)) }, 5000)
      later(() => { if (!res.destroyed) res.write(content('the answer '.repeat(8))) }, 5300)
      later(() => { if (!res.destroyed) end() }, 5600)
    } else if (scenario === 'recover' && hits > 1) {
      res.write(content('recovered answer'))
      end()
    } else if (scenario === 'tool') {
      res.write(gemini ? sse({ candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { file_path: 'fixture' } } }] } }] }) : sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'not-executed', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } }] } }] }))
    } else res.write(content('partial answer kept'))
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
process.env.MERCURY_GEMINI_API_BASE = `${base}/v1beta`
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = `${base}/token`
process.env.MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE = base
process.env.MERCURY_ANTIGRAVITY_MANIFEST_BASE = base
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ compatProvider: { llama: { baseUrl: `${base}/v1`, dialect: 'llamacpp', models: ['fixture'] } } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { compatCallModel } = await import('../../src/services/providers/openaicompat/compatCallModel.ts')
const { compatResponsesTransport } = await import('../../src/services/providers/openaicompat/compatResponsesTransport.ts')
const { isContinuableStreamFaultMessage } = await import('../../src/services/api/errors.ts')
const { isRecoveryBudgetSpentLine } = await import('../../src/services/api/recoveryBudget.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const idle = await import('../../src/services/providers/streamIdleBudget.ts')
const words = await import('../../src/components/Spinner/liveCounterWords.ts')
type Wait = import('../../src/services/providers/streamIdleBudget.ts').RequestWaitV1
type Facts = import('../../src/components/Spinner/liveCounterWords.ts').LiveCounterFacts
type Profile = import('../../src/services/providers/openaicompat/compatChatCallModel.ts').CompatLaneProfile
const profile: Profile = { lane: 'openai-compat', providerLabel: 'Fixture', requestUrl: () => `${base}/v1/chat/completions`, resolveCredential: () => ({}), credentialHint: '', wireModelId: () => 'fixture', buildExtras: () => ({ reasoning_effort: 'max', max_tokens: 32768 }) }
const freshFacts = (): Facts => ({ phase: 'waiting', sentAtMs: Date.now(), firstByteAtMs: null, replyChars: 0, thinkingChars: 0, wireOutputTokens: null, wait: null })
let facts = freshFacts()
const snapshots: Array<{ tag: string; facts: Facts }> = []
const waits: Wait[] = []
const realFetch = globalThis.fetch
let injectRead = false
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (injectRead && String(url).includes(':streamGenerateContent')) {
    hits++
    requests.push(JSON.parse(String(init?.body)))
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        sink.enqueue(new TextEncoder().encode(sse({ candidates: [{ content: { parts: [{ text: 'partial answer kept' }] } }] })))
        later(() => sink.error(new TypeError('terminated', { cause: Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'read' }) })), 30)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  if (!String(url).startsWith(base)) throw new Error(`fixture refused non-loopback request`)
  return realFetch(url as never, init)
}) as typeof fetch
async function drive(road: 'compat' | 'gemini', mode: typeof scenario, dialect?: string, abortAfterDelta = false) {
  scenario = mode
  injectRead = mode === 'read'
  hits = 0
  requests.length = 0
  waits.length = 0
  facts = freshFacts()
  const controller = new AbortController()
  const params = {
    messages: [createUserMessage({ content: dialect === 'routed' ? 'x'.repeat(240000) : 'go' })], systemPrompt: ['fixture'], thinkingConfig: { type: 'enabled', budgetTokens: 8192 }, tools: [], signal: controller.signal,
    options: { model: road === 'gemini' ? 'gemini-fixture' : 'compat/llama/fixture', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'max', onWait: (wait: Wait | null) => { facts.wait = wait; if (wait) waits.push(wait) } },
  }
  const items: any[] = []
  const waiting = mode === 'slow' ? setTimeout(() => snapshots.push({ tag: 'waiting', facts: { ...facts } }), 2000) : undefined
  try {
    const transport = dialect === 'responses' ? { streamTransport: (options: any, messages: any) => compatResponsesTransport(options, messages, base) } : {}
    for await (const item of road === 'gemini' ? geminiCallModel(params as never) : dialect === 'routed' ? compatCallModel(params as never) : compatChatCallModel({ ...profile, ...transport, ...(dialect ? { dialect } : {}) }, params as never)) {
      items.push(item)
      if (item.type !== 'stream_event') continue
      const event = item.event
      if (event.type === 'content_block_delta') {
        if (facts.firstByteAtMs === null) facts.firstByteAtMs = Date.now()
        if (event.delta.type === 'thinking_delta') { facts.phase = 'thinking'; facts.thinkingChars += event.delta.thinking.length }
        if (event.delta.type === 'text_delta') { facts.phase = 'writing'; facts.replyChars += event.delta.text.length }
        if (mode === 'slow') snapshots.push({ tag: facts.phase, facts: { ...facts } })
        if (abortAfterDelta) controller.abort()
      }
    }
  } finally { clearTimeout(waiting) }
  const answers = items.filter(i => i.type === 'assistant' && !i.isApiErrorMessage).flatMap(i => i.message.content.map((b: any) => b.text ?? ''))
  const errors = items.filter(i => i.type === 'assistant' && i.isApiErrorMessage).map(i => i.message.content.map((b: any) => b.text ?? '').join(''))
  return { items, answers, errors, hits, waits: [...waits], requests: [...requests] }
}
try {
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '10000'
  process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '9000'
  const slow = await drive('compat', 'slow')
  check('5 s first-token delay, reasoning then text settles once', slow.hits === 1 && slow.errors.length === 0 && snapshots.some(s => s.tag === 'waiting') && snapshots.some(s => s.tag === 'thinking') && snapshots.some(s => s.tag === 'writing'))
  const waiting = snapshots.find(s => s.tag === 'waiting')!
  check('headers do not erase the token wait', words.liveCounterWords(waiting.facts, waiting.facts.sentAtMs! + 2000).phase === 'waiting for the first token', JSON.stringify(waiting.facts))
  check('reasoning and text feed the shared live counter', snapshots.filter(s => s.tag !== 'waiting').every(s => words.liveCounterFigure(s.facts).total > 0))
  const React = await import('react')
  const { default: Ink } = await import('../../src/ink/ink.tsx')
  const { default: instances } = await import('../../src/ink/instances.ts')
  const { App } = await import('../../src/components/App.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { SpinnerWithVerb } = await import('../../src/components/Spinner.tsx')
  class Output extends EventEmitter { isTTY = true; rows = 40; constructor(public columns: number) { super() }; write() { return true } }
  class Input extends EventEmitter { isTTY = true; isRaw = false; setEncoding() { return this }; setRawMode(v: boolean) { this.isRaw = v; return this }; ref() { return this }; unref() { return this }; read() { return null }; get readableLength() { return 0 } }
  snapshots.push({ tag: 'no tokens for 2 min · reconnecting (1 of 3)', facts: { ...freshFacts(), thinkingChars: 4800, replyChars: 1200, wait: { kind: 'retry', attempt: 1, of: 3, sinceMs: Date.now(), delayMs: 5000, reason: 'no tokens for 2 min', reconnecting: true, silentMs: 120000 } as Wait } })
  snapshots.push({ tag: 'reading 60k tokens of context', facts: { ...freshFacts(), wait: { kind: 'first-byte', model: 'fixture', cold: true, promptTokens: 60000, budgetMs: 140000, sinceMs: Date.now(), attempt: 1, prefillMs: 20000 } as Wait } })
  for (const columns of [80, 120]) for (const compact of [false, true]) for (const sample of snapshots) {
    const stdout = new Output(columns)
    const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false })
    instances.set(stdout as never, ink)
    const f = sample.facts
    ink.render(React.createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, React.createElement(SpinnerWithVerb, {
      mode: f.phase === 'writing' ? 'responding' : f.phase === 'thinking' ? 'thinking' : 'requesting', compact,
      loadingStartTimeRef: { current: f.sentAtMs! }, totalPausedMsRef: { current: 0 }, pauseStartTimeRef: { current: null }, responseLengthRef: { current: f.replyChars + f.thinkingChars }, liveTurnFactsRef: { current: f }, verbose: true, hasActiveTools: false, activeToolCount: 0,
    })))
    await pause(150)
    const frame = stripAnsi(ink.lastFrameText())
    console.log(`FRAME ${columns} ${sample.tag}\n${frame}`)
    const expected = sample.tag === 'waiting' ? 'waiting for the first token' : sample.tag
    check(`spinner at ${columns}, compact=${compact}: ${expected}`, frame.includes(expected) && (!['thinking', 'writing'].includes(sample.tag) || frame.includes('tokens')) && (!sample.tag.startsWith('reading') || frame.includes('~20 s')), frame)
    ink.unmount()
    instances.delete(stdout as never)
  }
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1000'
  process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '400'
  for (const dialect of ['chat-completions', 'responses', 'llamacpp', 'vllm', 'sglang', 'ollama', 'lmstudio']) {
    const run = await drive('compat', 'silent', dialect)
    check(`${dialect}: silence reconnects then ends with one honest stop and partial kept`, run.hits >= 2 && run.errors.length === 1 && /the Fixture stream went silent for 1 s and did not reconnect/.test(run.errors[0]) && /nothing was lost before that; the request is not retried on its own/.test(run.errors[0]) && run.answers.includes('partial answer kept'), JSON.stringify(run))
    check(`${dialect}: reconnect wait survives the wire codec and names silence`, run.waits.some(w => /no tokens for 1 s · reconnecting \(1 of \d+\)/.test(idle.requestWaitLine(idle.decodeRequestWait(idle.requestWaitFromWire(idle.requestWaitToWire(w)))!))), JSON.stringify(run.waits))
    check(`${dialect}: spent silence cannot enter the automatic partial-stream continuation`, run.items.filter(i => i.type === 'assistant' && i.isApiErrorMessage).every(i => !isContinuableStreamFaultMessage(i)) && run.errors.length === 1 && run.errors.every(isRecoveryBudgetSpentLine))
  }
  const geminiSilent = await drive('gemini', 'silent')
  check('Gemini silence uses the same reconnect law and keeps partial text', geminiSilent.hits >= 2 && geminiSilent.errors.length === 1 && /the Gemini stream went silent/.test(geminiSilent.errors[0]) && geminiSilent.answers.includes('partial answer kept'), JSON.stringify(geminiSilent))
  const geminiRead = await drive('gemini', 'read')
  check('Gemini ETIMEDOUT read reconnects instead of ending on its first read-failed', geminiRead.hits >= 2 && geminiRead.waits.some(w => /reconnecting/.test(idle.requestWaitLine(w))) && geminiRead.errors.length === 1 && /did not reconnect/.test(geminiRead.errors[0]) && geminiRead.answers.includes('partial answer kept'), JSON.stringify(geminiRead))
  check('Gemini reconnect preserves model, thinking and request bytes', geminiRead.requests.length >= 2 && geminiRead.requests.every(r => JSON.stringify(r) === JSON.stringify(geminiRead.requests[0])))
  for (const road of ['compat', 'gemini'] as const) {
    const healed = await drive(road, 'recover')
    check(`${road}: one silent partial then recovered answer, no terminal error`, healed.hits === 2 && healed.answers.includes('recovered answer') && healed.answers.includes('partial answer kept') && healed.errors.length === 0, JSON.stringify(healed))
    const cancelled = await drive(road, 'cancel', undefined, true)
    check(`${road}: Esc keeps partial and makes no reconnect`, cancelled.hits === 1 && cancelled.answers.includes('partial answer kept') && cancelled.errors.length === 0, JSON.stringify(cancelled))
  }
  for (const road of ['compat', 'gemini'] as const) {
    const tool = await drive(road, 'tool')
    check(`${road}: an unfinished tool is not reissued or executed`, tool.hits === 1 && tool.errors.length === 1 && !tool.items.some(i => i.type === 'assistant' && i.message.content.some((b: any) => b.type === 'tool_use')), JSON.stringify(tool))
  }
  const accounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
  writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'plan', plan: { projectId: 'fixture-project', tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } } }))
  accounts.__resetGeminiAccountsForTest()
  const planRead = await drive('gemini', 'read')
  check('Google sign-in road: read timeout reconnects, partial kept, exhausted once', planRead.hits >= 2 && planRead.errors.length === 1 && planRead.answers.includes('partial answer kept') && planRead.waits.some(w => /reconnecting/.test(idle.requestWaitLine(w))), JSON.stringify(planRead))
  check('Google sign-in reconnect retains request contents, model and project', planRead.requests.length >= 2 && planRead.requests.every((r: any) => r.project === 'fixture-project' && r.model === (planRead.requests[0] as any).model && JSON.stringify(r.request.contents) === JSON.stringify((planRead.requests[0] as any).request.contents)))
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
  delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
  const window = idle.silentAfterHeadersWindowMs({ route: 'openai-compat', dialect: 'llamacpp', cold: true, promptTokens: 60000, idleMs: 120000, prefillTokensPerSecond: 3000 } as never)
  check('60k / 3k measured prefill adds 20 s before the idle window', window === 140000, window)
  check('a slower 100 tok/s engine is not cut by the old five-minute first-byte ceiling', idle.firstByteBudgetMs({ cold: true, promptTokens: 60000, idleMs: 120000, prefillMs: 600000 } as never) === 720000)
  const watchdog = idle.createStreamIdleWatchdog({ timeoutMs: 100, silentAfterHeadersMs: 400 })
  let early: unknown
  try { await watchdog.guard(pause(200)) } catch (error) { early = error }
  check('measured first-byte allowance survives beyond the ordinary idle budget', early === undefined && watchdog.fired() === null, early)
  watchdog.noteActivity()
  let afterByte: unknown
  try { await watchdog.guard(pause(300)) } catch (error) { afterByte = error }
  check('the first byte restores the normal silence budget', afterByte instanceof idle.StreamIdleTimeoutError && (afterByte as any).silentMs >= 100 && (afterByte as any).silentMs < 300, afterByte)
  watchdog.stop()
  const measured = await drive('compat', 'cancel', 'routed', true)
  const measuredWait = measured.waits.find(w => w.kind === 'first-byte') as Extract<Wait, { kind: 'first-byte' }> | undefined
  check('configured llama.cpp route feeds measured speed into the real request wait', measured.hits === 1 && measuredWait !== undefined && (measuredWait.prefillMs ?? 0) >= 20000 && measuredWait.budgetMs === idle.streamIdleTimeoutMsForRoute('openai-compat', 'llamacpp') + measuredWait.prefillMs!, JSON.stringify(measuredWait))
  check('prefill estimate survives the wait wire codec', measuredWait !== undefined && idle.decodeRequestWait(idle.requestWaitFromWire(idle.requestWaitToWire(measuredWait)))?.kind === 'first-byte' && isDeepStrictEqual(idle.decodeRequestWait(idle.requestWaitFromWire(idle.requestWaitToWire(measuredWait))), measuredWait))
  const probe = await import('../../src/services/providers/openaicompat/compatPrefill.ts').catch(() => null)
  check('the measured prefill probe exists', probe !== null)
  if (probe) {
    const speed = await probe.readCompatPrefillSpeed({ baseUrl: `${base}/v1`, dialect: 'llamacpp' }, 'fixture')
    check('llama.cpp probe reads real /metrics speed, not a fabricated /props field', speed === 3000, speed)
    check('SGLang token/time metric pairs produce the observed effective speed', probe.prefillSpeedFromMetrics('sglang', 'sglang:prompt_tokens_total{model_name="fixture",is_streaming="true"} 60000\nsglang:time_to_first_token_seconds_sum{model_name="fixture",is_streaming="true"} 20\n', 'fixture') === 3000)
    check('wrong model, empty or nonfinite speed stays unknown', probe.prefillSpeedFromMetrics('sglang', 'sglang:prompt_tokens_total{model_name="other"} 60000\nsglang:time_to_first_token_seconds_sum{model_name="other"} 20\n', 'fixture') === undefined && probe.prefillSpeedFromMetrics('llamacpp', 'llamacpp:prompt_tokens_seconds NaN\n', 'fixture') === undefined)
  }
} finally {
  globalThis.fetch = realFetch
  for (const t of timers) clearTimeout(t)
  for (const res of held) res.destroy()
  server.closeAllConnections()
  server.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
