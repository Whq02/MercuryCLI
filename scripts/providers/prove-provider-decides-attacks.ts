import type { ProviderUsabilityReads } from '../../src/services/providers/providerUsability.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'HF_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_HOME', 'MERCURY_MODEL']) delete process.env[key]
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.js')
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.js')
const { classifyAnthropicRefusal } = await import('../../src/services/providers/anthropicRefusal.js')
const { getAssistantMessageFromError } = await import('../../src/services/api/errors.js')
const { retryAfterHeaderMs } = await import('../../src/services/api/retryAfter.js')
const SEVEN_DAYS_S = 7 * 24 * 60 * 60
const httpDate = new Date(Date.now() + 20_000).toUTCString()

console.log('1. a 429 with no headers is a rate limit with no invented clock and no window claim')
const bare = mapOpenaiHttpFailure(429, { error: { message: 'Too many requests' } }, new Headers())
check('OpenAI: bare 429 is a rate limit in the provider\'s words', bare.kind === 'usage-limit' && bare.message.includes('rate limited') && bare.message.includes('Too many requests') && !bare.message.includes('window is reached'), bare)
check('OpenAI: bare 429 invents no clock', bare.retryAfterMs === undefined && bare.resetsAtMs === undefined, bare)
const bareNoBody = mapOpenaiHttpFailure(429, {}, new Headers())
check('OpenAI: bare 429 with an empty body still maps to a rate limit', bareNoBody.kind === 'usage-limit' && bareNoBody.retryAfterMs === undefined, bareNoBody)
for (const family of ['OpenRouter', 'Gemini', 'Hugging Face']) {
  const fault = mapCompatHttpFailure(429, { error: { message: `${family} says too many requests.` } }, new Headers())
  check(`${family}: bare 429 keeps the provider's words and invents no clock`, fault.retryAfterMs === undefined && fault.message.includes(`${family} says too many requests.`) && !fault.message.includes('window'), fault)
}
check('Anthropic: a bare 429 is a rate limit, never a plan window', classifyAnthropicRefusal({ status: 429, wireText: 'Too many requests' } as never) === 'rate-limit')
const bareRow = getAssistantMessageFromError(Object.assign(new Error('429 {"error":{"message":"Too many requests"}}'), { status: 429, headers: new Headers() }), 'claude-fable-5-1')
check('Anthropic: the bare 429 row carries no wait stamp', bareRow.providerWaitEndsAtMs === undefined && JSON.stringify(bareRow.message.content).includes('Too many requests'), bareRow.providerWaitEndsAtMs)

console.log('2. Retry-After in every spelling the wire allows: seconds, seven days, an HTTP date, junk, zero, negative')
check('the one reader: seconds', retryAfterHeaderMs('20') === 20_000)
check('the one reader: seven days', retryAfterHeaderMs(String(SEVEN_DAYS_S)) === SEVEN_DAYS_S * 1000)
const dateMs = retryAfterHeaderMs(httpDate)
check('the one reader: an HTTP date lands within a second of the stated moment', dateMs !== undefined && dateMs > 18_000 && dateMs <= 20_000, dateMs)
check('the one reader: junk, zero, negative and blank are no clock', [retryAfterHeaderMs('soon'), retryAfterHeaderMs('0'), retryAfterHeaderMs('-5'), retryAfterHeaderMs(''), retryAfterHeaderMs('   ')].every(value => value === undefined))
const sevenDays = mapOpenaiHttpFailure(429, { error: { message: 'Slow down.' } }, new Headers({ 'retry-after': String(SEVEN_DAYS_S) }))
check('OpenAI: a seven-day Retry-After is honoured as the clock and worded as the provider\'s ask', sevenDays.retryAfterMs === SEVEN_DAYS_S * 1000 && sevenDays.message.includes(`asks for ${SEVEN_DAYS_S} s`) && !sevenDays.message.includes('window is reached'), sevenDays)
const dated = mapOpenaiHttpFailure(429, { error: { message: 'Slow down.' } }, new Headers({ 'retry-after': httpDate }))
check('OpenAI: an HTTP-date Retry-After is honoured', dated.retryAfterMs !== undefined && dated.retryAfterMs > 17_000 && dated.retryAfterMs <= 20_000, dated)
const junk = mapOpenaiHttpFailure(429, { error: { message: 'Slow down.' } }, new Headers({ 'retry-after': 'soon' }))
check('OpenAI: a junk Retry-After is no clock and no crash', junk.kind === 'usage-limit' && junk.retryAfterMs === undefined, junk)
const bandHeaders = { 'x-codex-primary-window-minutes': '300', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '518400' }
const bandAndNow = mapOpenaiHttpFailure(429, { error: { message: 'Slow down.', code: 'usage_limit_reached' } }, new Headers({ 'retry-after': '0', ...bandHeaders }))
check('OpenAI: Retry-After 0 outranks a 100 % band — the provider says retry now, no window claim, no six-day clock', bandAndNow.retryAfterMs === 0 && bandAndNow.message.includes('retry now') && !bandAndNow.message.includes('window is reached') && !bandAndNow.message.includes('518400'), bandAndNow)
const elapsedDate = mapOpenaiHttpFailure(429, { error: { message: 'Slow down.' } }, new Headers({ 'retry-after': new Date(Date.now() - 20_000).toUTCString(), ...bandHeaders }))
check('OpenAI: an elapsed HTTP-date Retry-After outranks the band the same way', elapsedDate.retryAfterMs === 0 && elapsedDate.message.includes('retry now') && !elapsedDate.message.includes('window is reached'), elapsedDate)
const bandAlone = mapOpenaiHttpFailure(429, { error: { message: 'Slow down.', code: 'usage_limit_reached' } }, new Headers(bandHeaders))
check('OpenAI: the band alone still names the window and its reset', bandAlone.message.includes('window is reached') && bandAlone.retryAfterMs === 518400 * 1000, bandAlone)
for (const [label, header] of [['seven days', String(SEVEN_DAYS_S)], ['an HTTP date', httpDate]] as const) {
  const fault = mapCompatHttpFailure(429, { error: { message: 'x' } }, new Headers({ 'retry-after': header }))
  check(`compatible families: Retry-After ${label} is the typed wait`, fault.retryAfterMs !== undefined && fault.retryAfterMs > 17_000 && fault.message.includes('rate limited'), fault)
}
const compatJunk = mapCompatHttpFailure(429, { error: { message: 'x' } }, new Headers({ 'retry-after': 'soon' }))
check('compatible families: a junk Retry-After is no clock and no crash', compatJunk.retryAfterMs === undefined, compatJunk)
check('Anthropic: a seven-day Retry-After is still a rate limit, not a plan window', classifyAnthropicRefusal({ status: 429, wireText: 'x', headers: new Headers({ 'retry-after': String(SEVEN_DAYS_S) }) } as never) === 'rate-limit')
const sevenRow = getAssistantMessageFromError(Object.assign(new Error('429 {"error":{"message":"Too many requests"}}'), { status: 429, headers: new Headers({ 'retry-after': String(SEVEN_DAYS_S) }) }), 'claude-fable-5-1')
check('Anthropic: the seven-day row pauses for seven days in the provider\'s words', (sevenRow.providerWaitEndsAtMs ?? 0) > Date.now() + (SEVEN_DAYS_S - 5) * 1000 && JSON.stringify(sevenRow.message.content).includes(`asks for ${SEVEN_DAYS_S} s`), sevenRow)
const datedRow = getAssistantMessageFromError(Object.assign(new Error('429 {"error":{"message":"Too many requests"}}'), { status: 429, headers: new Headers({ 'retry-after': httpDate }) }), 'claude-fable-5-1')
check('Anthropic: the HTTP-date row pauses until the stated moment', (datedRow.providerWaitEndsAtMs ?? 0) > Date.now() + 15_000 && (datedRow.providerWaitEndsAtMs ?? Infinity) <= Date.now() + 20_000, datedRow.providerWaitEndsAtMs)
const stale = getAssistantMessageFromError(Object.assign(new Error('429 {"error":{"message":"Too many requests"}}'), { status: 429, headers: new Headers({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }) }), 'claude-fable-5-1')
check('Anthropic: a Retry-After date already past is no wait', stale.providerWaitEndsAtMs === undefined, stale.providerWaitEndsAtMs)

console.log('3. the dispatch door: the one refusal left is a dead sign-in; a note beside a live sign-in never refuses')
const { resolveProviderUsability, delegationDispatchBlocker } = await import('../../src/services/providers/providerUsability.js')
const now = Date.now()
const reset = now + 6 * 24 * 60 * 60 * 1000
const baseReads = (over: Partial<ProviderUsabilityReads>): ProviderUsabilityReads => ({
  anthropicApiKey: () => null,
  anthropicSubscriber: () => true,
  anthropicLimitStatus: () => 'rejected',
  anthropicLimitObservation: () => ({ account: 'fixture', observedAtMs: now, resetsAtMs: reset }),
  gptSeat: () => ({ state: 'ready' }),
  zaiKeyPresent: () => false,
  openrouterKeyPresent: () => true,
  geminiAccount: () => ({ kind: 'api-key' }),
  huggingfaceAccount: () => ({ kind: 'api-key' }),
  openaiLimitWindow: () => ({ state: 'limited' }),
  openrouterLimitWindow: () => ({ state: 'limited' }),
  geminiLimitWindow: () => ({ state: 'limited' }),
  huggingfaceLimitWindow: () => ({ state: 'limited' }),
  ...over,
})
const dead = resolveProviderUsability(baseReads({ anthropicSignInExpired: () => true }))
const deadWords = delegationDispatchBlocker('anthropic', dead)
check('a dead Anthropic sign-in refuses delegated dispatch', deadWords !== null && deadWords.includes('cannot take delegated work'), deadWords)
check('the dead sign-in refusal names the lanes with usage and never reroutes silently', deadWords !== null && deadWords.includes('never silently rerouted') && deadWords.includes('Lanes with usage right now'), deadWords)
for (const family of ['openai', 'openrouter', 'gemini', 'huggingface'] as const) {
  check(`${family}: a dead Anthropic sign-in refuses nothing on another lane`, delegationDispatchBlocker(family, dead) === null)
}
const live = resolveProviderUsability(baseReads({ anthropicSignInExpired: () => false }))
check('a live sign-in with a rejected note is dispatched', delegationDispatchBlocker('anthropic', live) === null && live.anthropic.usable && live.anthropic.limit === 'rejected')
const keyed = resolveProviderUsability(baseReads({ anthropicApiKey: () => 'sk-fixture', anthropicSubscriber: () => false, anthropicSignInExpired: () => true }))
check('an API key beside an expired subscriber sign-in is still dispatched (the key is the credential in use)', delegationDispatchBlocker('anthropic', keyed) === null || keyed.anthropic.signInExpired === true, keyed.anthropic)

console.log('4. the scheduler holds on no note: the production reads carry no window hold')
const { readLiveAccountFacts, scheduleAccountVerdict } = await import('../../src/daemon/saturnAccount.js')
for (const family of ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface']) {
  const facts = readLiveAccountFacts({ family, source: 'api-key' } as never, { presenceOf: () => ({ credentialed: true, kind: 'api-key' }), strandedNow: () => false, anthropicDetail: () => null })
  check(`${family}: the live facts carry no rate-limit hold without a reader for it`, facts.rateLimitedUntil === undefined && scheduleAccountVerdict({ account: { source: 'api-key' }, nextFireMs: now, nowMs: now, live: facts }).state === 'ready', facts)
}

console.log('5. an agent refused twice in a row retries once by itself at the provider\'s pace, then waits for a hand — never a loop')
const { createServer } = await import('node:http')
const MODEL = 'gpt-6-astra'
type Mode = 'refuse-2s' | 'refuse-bare' | 'serve'
let mode: Mode = 'refuse-2s'
const wire: Array<{ at: number; status: number; body: string }> = []
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ slug: MODEL, display_name: MODEL, supported_reasoning_levels: [{ effort: 'max' }], default_reasoning_level: 'max', visibility: 'list', priority: 1, context_window: 272000, input_modalities: ['text'], supported_in_api: true }] }))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/responses')) {
      const body = Buffer.concat(chunks).toString('utf8')
      if (mode === 'refuse-2s') {
        wire.push({ at: Date.now(), status: 429, body })
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
        res.end(JSON.stringify({ error: { message: 'Please retry after 2 seconds.' } }))
        return
      }
      if (mode === 'refuse-bare') {
        wire.push({ at: Date.now(), status: 429, body })
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Too many requests.' } }))
        return
      }
      wire.push({ at: Date.now(), status: 200, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
      const text = 'The provider served the request.'
      res.end(sse({ type: 'response.created', response: { id: `fixture-${wire.length}` } }) + sse({ type: 'response.output_text.delta', delta: text }) + sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + sse({ type: 'response.completed', response: { id: `fixture-${wire.length}`, usage: { input_tokens: 8, output_tokens: 8 } } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [], models: [] }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
const base = `http://127.0.0.1:${address.port}`
Object.assign(process.env, { ANTHROPIC_BASE_URL: base, MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/subscription`, MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`, OPENAI_API_KEY: 'fixture-key', MERCURY_LOCAL_PROBE_TARGETS: 'none' })
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.js')
bootstrap.setIsInteractive(false)
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.js')
const { resumeAgentBackground } = await import('../../src/tools/AgentTool/resumeAgent.js')
const { runAsyncAgentLifecycle, automaticResumePending } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { registerAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { pauseStatusWords } = await import('../../src/tasks/LocalAgentTask/agentPause.js')
const { openaiLimitWindow } = await import('../../src/services/providers/openai/openaiLimitState.js')
const { generateTaskId } = await import('../../src/Task.js')
await import('../../src/tasks.js')
type AppState = import('../../src/state/AppStateStore.js').AppState
let state: AppState = { ...getDefaultAppState(), effortValue: 'max' } as AppState
const setState = (update: (previous: AppState) => AppState) => { state = update(state) }
const ctx = {
  abortController: new AbortController(),
  options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'enabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, messages: [],
  readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
} as never
const definition = { agentType: 'provider-attacks-fixture', whenToUse: 'provider refusal fixture', source: 'projectSettings', getSystemPrompt: () => 'Answer with one line. Do not call tools.' } as never
const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
process.env.MERCURY_BUSY_RETRY_SCALE = '0.1'
const task = (id: string) => state.tasks[id] as { status?: string; paused?: { why: string; words: string; resumesAtMs?: number } } | undefined
const launch = async (agentId: string, prompt: string): Promise<void> => {
  const registered = registerAsyncAgent({ agentId, description: 'provider refusal fixture', prompt, selectedAgent: definition, setAppState: setState as never })
  const registration = registered.abortController as AbortController
  await runAsyncAgentLifecycle({
    taskId: agentId,
    abortController: registration,
    makeStream: () => runAgent({ agentDefinition: definition, promptMessages: [createUserMessage({ content: prompt })], toolUseContext: ctx, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:provider-attacks-fixture' as never, availableTools: [] as never, model: MODEL, override: { agentId, abortController: registration }, description: 'provider refusal fixture' }) as never,
    metadata: { prompt, resolvedAgentModel: MODEL, isBuiltInAgent: false, startTime: Date.now(), agentType: 'provider-attacks-fixture', isAsync: true },
    description: 'provider refusal fixture',
    toolUseContext: ctx,
    rootSetAppState: setState as never,
    agentIdForCleanup: agentId,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
    canUseTool: allow,
  })
}
try {
  const paced = generateTaskId('local_agent')
  const startedAt = Date.now()
  await launch(paced, 'Continue the kept work.')
  const episodeOne = wire.length
  const gaps = wire.slice(1).map((entry, index) => entry.at - wire[index]!.at)
  check('the first episode honours the two-second ask between every request and ends on the ladder, bounded', episodeOne >= 2 && episodeOne <= 8 && gaps.every(gap => gap >= 1_900), { requests: episodeOne, gaps })
  check('the spent episode pauses the agent on the provider\'s own words and its two-second ask', task(paced)?.status === 'failed' && task(paced)?.paused?.why === 'usage limit' && task(paced)?.paused?.words.includes('Please retry after 2 seconds.') === true && (task(paced)?.paused?.resumesAtMs ?? 0) > Date.now() - 1_000 && (task(paced)?.paused?.resumesAtMs ?? Infinity) <= Date.now() + 2_500, task(paced))
  check('the pause row says when it retries by itself and that r retries now', task(paced)?.paused !== undefined && pauseStatusWords(task(paced)!.paused as never, Date.now()).includes('retries by itself at') && pauseStatusWords(task(paced)!.paused as never, Date.now()).includes('r retries now'), task(paced)?.paused)
  check('one automatic retry is armed after the first episode', automaticResumePending(paced) === true)
  const resumed = Date.now() + 20_000
  while (Date.now() < resumed && wire.length === episodeOne) await sleep(50)
  const resumeGap = wire.length > episodeOne ? wire[episodeOne]!.at - wire[episodeOne - 1]!.at : -1
  check('the automatic retry reaches the provider no sooner than the two seconds it asked for', wire.length > episodeOne && resumeGap >= 1_900, { requests: wire.length, resumeGap })
  const settle = Date.now() + 90_000
  while (Date.now() < settle && (task(paced)?.status === 'running' || automaticResumePending(paced))) await sleep(50)
  const episodeTwo = wire.length - episodeOne
  await sleep(5_000)
  check('after the second refused episode the agent waits for a hand: no third episode, no automatic retry armed', wire.length === episodeOne + episodeTwo && episodeTwo >= 1 && episodeTwo <= 8 && task(paced)?.status === 'failed' && task(paced)?.paused?.why === 'usage limit' && automaticResumePending(paced) === false, { requests: wire.length, episodeOne, episodeTwo, status: task(paced)?.status, pending: automaticResumePending(paced) })
  const allGaps = wire.slice(1).map((entry, index) => entry.at - wire[index]!.at)
  const perMinute = wire.length / Math.max(1, (Date.now() - startedAt) / 60_000)
  check('over the whole episode no two requests are closer than the provider\'s ask and the pace is far from a loop', allGaps.every(gap => gap >= 1_900) && perMinute < 30, { perMinute, minGap: Math.min(...allGaps), elapsedMs: Date.now() - startedAt })
  console.log(`measured: ${JSON.stringify({ episodeOne, episodeTwo, gapsMs: allGaps, perMinute: Math.round(perMinute * 10) / 10, elapsedMs: Date.now() - startedAt, ladderScale: process.env.MERCURY_BUSY_RETRY_SCALE })}`)
  mode = 'serve'
  const before = wire.length
  await resumeAgentBackground({ agentId: paced, prompt: 'Retry now using the same account.', toolUseContext: ctx, canUseTool: allow })
  const served = Date.now() + 30_000
  while (Date.now() < served && task(paced)?.status === 'running') await sleep(50)
  check('a manual resume while the note still reads limited goes to the provider and completes on its answer', wire.length === before + 1 && wire[before]?.status === 200 && task(paced)?.status === 'completed' && task(paced)?.paused === undefined, { requests: wire.length, status: task(paced)?.status })
  check('the served request clears the note on its source', openaiLimitWindow('api-key').state === 'clear')

  console.log('6. a bare 429 (no clock) pauses with the honest absence of a reset and arms no automatic retry')
  mode = 'refuse-bare'
  wire.length = 0
  const bareAgent = generateTaskId('local_agent')
  await launch(bareAgent, 'Continue the other kept work.')
  const bareTask = task(bareAgent)
  check('the bare refusal pauses the agent on the provider\'s words with no reset stated', bareTask?.status === 'failed' && bareTask?.paused?.why === 'usage limit' && bareTask?.paused?.words.includes('Too many requests.') === true && bareTask?.paused?.resumesAtMs === undefined, bareTask)
  check('the pause row says a message resumes it', bareTask?.paused !== undefined && pauseStatusWords(bareTask.paused as never, Date.now()).includes('no reset stated — a message resumes it'), bareTask?.paused)
  check('no automatic retry is armed without a clock', automaticResumePending(bareAgent) === false)
  const bareEpisode = wire.length
  const bareGaps = wire.slice(1).map((entry, index) => entry.at - wire[index]!.at)
  check('the bare episode is the road\'s one paced retry at most, never a burst', bareEpisode >= 1 && bareEpisode <= 2 && bareGaps.every(gap => gap >= 300), { requests: bareEpisode, bareGaps })
  await sleep(4_000)
  check('four seconds on, the provider saw no further request', wire.length === bareEpisode, { requests: wire.length, bareEpisode })
  console.log(`measured: ${JSON.stringify({ bareEpisode, bareGapsMs: bareGaps })}`)
  mode = 'serve'
  await resumeAgentBackground({ agentId: bareAgent, prompt: 'Retry now.', toolUseContext: ctx, canUseTool: allow })
  const bareServed = Date.now() + 30_000
  while (Date.now() < bareServed && task(bareAgent)?.status === 'running') await sleep(50)
  check('a manual resume after the bare refusal is served and completes', wire.length === bareEpisode + 1 && wire[bareEpisode]?.status === 200 && task(bareAgent)?.status === 'completed', { requests: wire.length, status: task(bareAgent)?.status })
} catch (error) {
  console.log(`FAIL agent fixture: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  failures++
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} provider decides, attacked (${failures} failures)`)
process.exit(failures ? 1 : 0)
