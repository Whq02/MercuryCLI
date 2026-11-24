import type { ProviderUsabilityReads } from '../../src/models/roads/providerUsability.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'HF_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_HOME', 'MERCURY_MODEL']) delete process.env[key]
const { resolveProviderUsability, delegationDispatchBlocker } = await import('../../src/models/roads/providerUsability.js')
const { recordOpenaiUsageLimit, openaiLimitWindow } = await import('../../src/models/roads/openai/openaiLimitState.js')
const { recordOpenrouterRateHeaders, openrouterLimitWindow } = await import('../../src/models/roads/openrouter/openrouterUsageState.js')
const { recordGeminiUsageLimit, geminiLimitWindow } = await import('../../src/models/roads/gemini/geminiUsageState.js')
const { recordHuggingfaceRateHeaders, huggingfaceLimitWindow } = await import('../../src/models/roads/huggingface/huggingfaceUsageState.js')
let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok && detail !== undefined) console.log('  what to change: ' + detail)
  if (!ok) failures++
}
const now = Date.now()
const reset = now + 6 * 24 * 60 * 60 * 1000
recordOpenaiUsageLimit(reset, 'chatgpt-subscription')
recordOpenrouterRateHeaders(new Headers({ 'x-ratelimit-reset': String(reset) }))
recordGeminiUsageLimit(reset)
recordHuggingfaceRateHeaders(new Headers({ 'x-ratelimit-reset': String(reset) }), 429)
const reads: ProviderUsabilityReads = {
  anthropicApiKey: () => null,
  anthropicSubscriber: () => true,
  anthropicLimitStatus: () => 'rejected',
  anthropicLimitObservation: () => ({ account: 'fixture', observedAtMs: now, resetsAtMs: reset }),
  gptSeat: () => ({ state: 'ready' }),
  zaiKeyPresent: () => false,
  openrouterKeyPresent: () => true,
  geminiAccount: () => ({ kind: 'api-key' }),
  huggingfaceAccount: () => ({ kind: 'api-key' }),
  openaiLimitWindow: () => openaiLimitWindow('chatgpt-subscription'),
  openrouterLimitWindow,
  geminiLimitWindow,
  huggingfaceLimitWindow,
}
const map = resolveProviderUsability(reads)
for (const family of ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface'] as const) {
  check(`${family}: a six-day note never refuses dispatch`, delegationDispatchBlocker(family, map) === null, 'delegationDispatchBlocker in src/models/roads/providerUsability.ts must return null for a note whose reset is six days away; a long reading may be shown but must not block dispatch')
  check(`${family}: credentialed lane stays usable with its reading`, map[family].usable && map[family].limit === 'rejected' && Boolean(map[family].limitBlocker) && map[family].blockers.length === 0, 'resolveProviderUsability in src/models/roads/providerUsability.ts must keep a credentialed lane usable with limit set to rejected and a limitBlocker, and leave blockers empty')
}
check('Anthropic: a window never caps delegation', map.anthropic.delegationCapped === false, 'resolveProviderUsability in src/models/roads/providerUsability.ts must not set delegationCapped for the Anthropic family when only a window reading exists')
const clearNames = [
  ['openai', await import('../../src/models/roads/openai/openaiLimitState.js'), 'clearOpenaiUsageLimit', () => openaiLimitWindow('chatgpt-subscription')],
  ['openrouter', await import('../../src/models/roads/openrouter/openrouterUsageState.js'), 'clearOpenrouterUsageLimit', openrouterLimitWindow],
  ['gemini', await import('../../src/models/roads/gemini/geminiUsageState.js'), 'clearGeminiUsageLimit', geminiLimitWindow],
  ['huggingface', await import('../../src/models/roads/huggingface/huggingfaceUsageState.js'), 'clearHuggingfaceUsageLimit', huggingfaceLimitWindow],
] as const
for (const [family, owner, name, window] of clearNames) {
  const clear = (owner as unknown as Record<string, unknown>)[name]
  if (typeof clear === 'function') clear('chatgpt-subscription')
  check(`${family}: a served response clears the note`, typeof clear === 'function' && window().state === 'clear', 'the usage-state module for ' + family + ' under src/models/roads/ must export ' + name + ' and calling it must make its limit window read clear')
}
const { openrouterLaneProfile } = await import('../../src/models/roads/openrouter/openrouterCallModel.js')
const { geminiLaneProfile } = await import('../../src/models/roads/gemini/geminiCallModel.js')
const { huggingfaceLaneProfile } = await import('../../src/models/roads/huggingface/huggingfaceCallModel.js')
for (const [profile, window] of [[openrouterLaneProfile, openrouterLimitWindow], [geminiLaneProfile, geminiLimitWindow], [huggingfaceLaneProfile, huggingfaceLimitWindow]] as const) {
  profile.onResponseHeaders?.(new Headers({ 'retry-after': '518400' }), 429)
  check(`${profile.lane}: the response road records its refusal`, window().state === 'limited', 'onResponseHeaders on the ' + profile.lane + ' lane profile (its callModel file under src/models/roads/) must record a 429 with retry-after into the lane limit window')
  profile.onResponseHeaders?.(new Headers(), 200)
  check(`${profile.lane}: the response road clears its note on success`, window().state === 'clear', 'onResponseHeaders on the ' + profile.lane + ' lane profile (its callModel file under src/models/roads/) must clear the lane limit window on a 200 response')
}
process.env.MERCURY_MOCK_LIMITS = '1'
const anthropic = await import('../../src/models/roads/anthropic/anthropicLimits.js')
const mock = await import('../../src/models/roads/anthropic/mockRateLimits.js')
anthropic.__setAnthropicOwnerResolverForTest(() => 'fixture-owner', () => 'fixture-account')
mock.setMockRateLimitScenario('weekly-limit-reached')
anthropic.extractQuotaStatusFromHeaders(new Headers())
const clearAnthropic = (anthropic as unknown as Record<string, unknown>).clearAnthropicUsageLimit
if (typeof clearAnthropic === 'function') clearAnthropic()
check('Anthropic: a served response clears its refusal', typeof clearAnthropic === 'function' && anthropic.anthropicLimitVerdict().status === 'allowed', 'src/models/roads/anthropic/anthropicLimits.ts must export clearAnthropicUsageLimit and calling it must make anthropicLimitVerdict read allowed')
mock.setMockRateLimitScenario('clear')
anthropic.resetLimitsForCredentialSwitch()
anthropic.__setAnthropicOwnerResolverForTest(null)
delete process.env.MERCURY_MOCK_LIMITS
const { mapOpenaiHttpFailure } = await import('../../src/models/roads/openai/openaiWire.js')
const { mapCompatHttpFailure } = await import('../../src/models/roads/openaicompat/compatChatClient.js')
const { classifyAnthropicRefusal } = await import('../../src/models/roads/anthropicRefusal.js')
const beforeShort = Date.now()
const shortHeaders = new Headers({ 'retry-after': '20', 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-after-seconds': '518400' })
const short = mapOpenaiHttpFailure(429, { error: { message: 'Please retry after 20 seconds.' } }, shortHeaders)
check('OpenAI: Retry-After wins over a six-day band in words and clock', short.kind === 'usage-limit' && short.retryAfterMs === 20000 && short.message.includes('rate limited') && !short.message.includes('window is reached') && (short.resetsAtMs ?? Infinity) <= beforeShort + 21000, 'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must let an explicit Retry-After of 20 s win over the six-day codex band: kind usage-limit, retryAfterMs 20000, a rate limited message and a reset within 21 s; got ' + JSON.stringify(short))
const bodyShort = mapOpenaiHttpFailure(429, { error: { resets_in_seconds: 20, message: 'Slow down.' } })
check('OpenAI: a short body wait is a rate limit', bodyShort.message.includes('rate limited') && bodyShort.retryAfterMs === 20000, 'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must treat a body resets_in_seconds of 20 as a rate limit with retryAfterMs 20000; got ' + JSON.stringify(bodyShort))
const weekly = mapOpenaiHttpFailure(429, { error: { type: 'usage_limit_reached', plan_type: 'fixture', resets_in_seconds: 518400, message: 'The weekly usage limit was reached.' } })
check('OpenAI: a stated plan window retains its words and reset', weekly.message.includes('the fixture window is reached') && weekly.retryAfterMs === 518400000, 'mapOpenaiHttpFailure in src/models/roads/openai/openaiWire.ts must keep the plan window words (the fixture window is reached) and a retryAfterMs of 518400000 for a stated usage_limit_reached; got ' + JSON.stringify(weekly))
for (const family of ['OpenRouter', 'Gemini', 'Hugging Face']) {
  const fault = mapCompatHttpFailure(429, { error: { message: `${family} asks for a retry.` } }, shortHeaders)
  check(`${family}: the shared 429 road preserves the explicit wait`, fault.retryAfterMs === 20000 && fault.message.includes('rate limited') && fault.message.includes('20 s'), 'mapCompatHttpFailure in src/models/roads/openaicompat/compatChatClient.ts must keep the explicit Retry-After as retryAfterMs 20000 and say rate limited and 20 s in the message; got ' + JSON.stringify(fault))
}
const nativeRetry = mapCompatHttpFailure(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Wait for capacity.', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }] } })
check('Gemini: the native RetryInfo delay is honored', nativeRetry.retryAfterMs === 20000, 'mapCompatHttpFailure in src/models/roads/openaicompat/compatChatClient.ts must read the RetryInfo retryDelay 20s from the error details as retryAfterMs 20000; got ' + JSON.stringify(nativeRetry))
check('Anthropic: a short explicit ask is not a plan window', classifyAnthropicRefusal({ status: 429, wireText: 'Rate limit exceeded', headers: new Headers({ 'retry-after': '20', 'anthropic-ratelimit-unified-status': 'rejected' }) } as never) === 'rate-limit', 'classifyAnthropicRefusal in src/models/roads/anthropicRefusal.ts must return rate-limit when a 429 carries a short retry-after, even with a rejected unified status')
check('Anthropic: a stated plan window remains a window', classifyAnthropicRefusal({ status: 429, wireText: 'usage_limit_reached' }) === 'window', 'classifyAnthropicRefusal in src/models/roads/anthropicRefusal.ts must return window for a 429 whose text states usage_limit_reached')
const { getAssistantMessageFromError } = await import('../../src/engine/requests/apiErrorRows.js')
const burstAt = Date.now()
const burstRow = getAssistantMessageFromError(Object.assign(new Error('429 {"error":{"message":"Please retry after 20 seconds."}}'), { status: 429, headers: new Headers({ 'retry-after': '20', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 518400) }) }), 'claude-fable-5-1')
check('Anthropic: the refusal row says rate limited and pauses for the explicit 20 seconds', JSON.stringify(burstRow.message.content).includes('rate limited') && (burstRow.providerWaitEndsAtMs ?? 0) >= burstAt + 20000 && (burstRow.providerWaitEndsAtMs ?? Infinity) <= Date.now() + 20000, 'getAssistantMessageFromError in src/engine/requests/apiErrorRows.ts must word the refusal row as rate limited and set providerWaitEndsAtMs to about 20 s from now when retry-after is 20; got providerWaitEndsAtMs ' + String(burstRow.providerWaitEndsAtMs))
const { liveFactsForSessionFire, scheduleAccountVerdict } = await import('../../src/daemon/saturn/saturnAccount.js')
for (const family of ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface']) {
  const live = liveFactsForSessionFire({ family, source: 'api-key' }, 'fixture-session', {
    presenceOf: () => ({ credentialed: true, kind: 'api-key' }),
    strandedNow: () => false,
    anthropicDetail: () => null,
    factsOf: () => ({ usage: { [`${family}Window`]: { status: 'rejected', owner: 'fixture', source: 'api-key', observedAtMs: now, resetsAtMs: reset } } }) as never,
    now: () => now,
  })
  check(`${family}: a scheduled request is not deferred by a six-day note`, scheduleAccountVerdict({ account: { source: 'api-key' }, nextFireMs: now, nowMs: now, live }).state === 'ready', 'scheduleAccountVerdict and liveFactsForSessionFire in src/daemon/saturn/saturnAccount.ts must not defer a scheduled fire for a six-day window note on the ' + family + ' family')
}
const { createServer } = await import('node:http')
const MODEL = 'gpt-6-astra'
const wire: Array<{ status: number; body: string }> = []
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
      const status = wire.length === 0 ? 429 : 200
      wire.push({ status, body: Buffer.concat(chunks).toString('utf8') })
      if (status === 429) {
        res.writeHead(429, { 'content-type': 'application/json', 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-after-seconds': '518400' })
        res.end(JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'fixture', message: 'The weekly usage limit was reached.' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
      const text = 'The provider served the resumed request.'
      res.end(sse({ type: 'response.created', response: { id: 'fixture-resumed' } }) + sse({ type: 'response.output_text.delta', delta: text }) + sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + sse({ type: 'response.completed', response: { id: 'fixture-resumed', usage: { input_tokens: 8, output_tokens: 8 } } }))
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
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.js')
bootstrap.setIsInteractive(false)
const { runCrewmate } = await import('../../src/tools/crewmate/runCrewmate.js')
const { resumeCrewmateBackground } = await import('../../src/tools/crewmate/resumeCrewmate.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createUserMessage } = await import('../../src/engine/messages/messages.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.js')
const { turnDoor: startTurn } = await import('../../src/engine/turnDoor.ts')
const { getCrewmateTranscript } = await import('../../src/sessions/transcripts/sessionListings.js')
const { registerAsyncCrewmate, failCrewmateTask, pauseCrewmateTask, usageWindowPauseOf } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const { generateTaskId } = await import('../../src/engine/tasks/taskBase.js')
await import('../../src/engine/tasks/tasks.js')
type Message = import('../../src/engine/message-shapes/message.js').Message
type AppState = import('../../src/screen/app-state/AppStateStore.js').AppState
let state: AppState = { ...getDefaultAppState(), effortValue: 'max' } as AppState
const setState = (update: (previous: AppState) => AppState) => { state = update(state) }
const ctx = {
  abortController: new AbortController(),
  options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'enabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, messages: [],
  startTurn,
  readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
} as never
const definition = { agentType: 'provider-decides-fixture', whenToUse: 'provider refusal fixture', source: 'projectSettings', getSystemPrompt: () => 'Answer with one line. Do not call tools.' } as never
const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
const agentId = generateTaskId('local_agent')
const rows: Message[] = []
try {
  for await (const row of runCrewmate({ agentDefinition: definition, promptMessages: [createUserMessage({ content: 'Continue the kept work.' })], toolUseContext: ctx, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:provider-decides-fixture' as never, availableTools: [] as never, model: MODEL, override: { agentId }, description: 'provider refusal fixture' })) {
    if (row.type === 'assistant' || row.type === 'user') rows.push(row as Message)
  }
  const pause = usageWindowPauseOf(rows, MODEL)
  const { pauseStatusWords } = await import('../../src/engine/tasks/local-agent/crewmatePause.js')
  check('the refusal row invites the next request on the same provider', pause?.words.includes('The next request goes to OpenAI again; resume any time.') === true, 'the pause words built from the refusal by usageWindowPauseOf in src/engine/tasks/local-agent/crewmateTask.tsx must say that the next request goes to OpenAI again; got ' + JSON.stringify(pause))
  check('the pause carries the provider answer and names both retry doors', pause !== null && pause.words.includes('The weekly usage limit was reached.') && pauseStatusWords(pause, Date.now()).includes('retries by itself at') && pauseStatusWords(pause, Date.now()).includes('r retries now'), 'the pause from usageWindowPauseOf in src/engine/tasks/local-agent/crewmateTask.tsx must carry the provider message, and pauseStatusWords in src/engine/tasks/local-agent/crewmatePause.ts must name both retries by itself at and r retries now; got ' + JSON.stringify(pause))
  check('the agent reaches a real fixture 429 once and keeps its six-day automatic retry', wire.length === 1 && wire[0]?.status === 429 && pause?.resumesAtMs !== undefined && pause.resumesAtMs > Date.now() + 5 * 24 * 60 * 60 * 1000, 'the agent must send exactly one request that the fixture refuses with 429 and usageWindowPauseOf in src/engine/tasks/local-agent/crewmateTask.tsx must set resumesAtMs about six days ahead; requests seen ' + String(wire.length) + ', resumesAtMs ' + String(pause?.resumesAtMs))
  registerAsyncCrewmate({ agentId, description: 'provider refusal fixture', prompt: 'Continue the kept work.', selectedAgent: definition, setAppState: setState as never })
  failCrewmateTask(agentId, 'fixture usage refusal', setState as never)
  if (pause) pauseCrewmateTask(agentId, pause, setState as never)
  await resumeCrewmateBackground({ agentId, prompt: 'Retry now using the same account.', toolUseContext: ctx, canUseTool: allow })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && state.tasks[agentId]?.status === 'running') await new Promise(resolve => setTimeout(resolve, 50))
  check('manual resume reaches the wire without relogin', wire.length === 2 && wire[1]?.status === 200 && wire[1]?.body.includes('Retry now using the same account.') === true, 'resumeCrewmateBackground in src/tools/crewmate/resumeCrewmate.ts must send the resume prompt to the provider as a second request that is served with 200; requests seen ' + String(wire.length))
  check('the resumed agent completes on the served answer', state.tasks[agentId]?.status === 'completed', 'resumeCrewmateBackground in src/tools/crewmate/resumeCrewmate.ts must finish the task as completed once the second request is served; status is ' + String(state.tasks[agentId]?.status))
  check('the served OpenAI response clears the note on its own source', openaiLimitWindow('api-key').state === 'clear', 'a served OpenAI response must clear the api-key note through src/models/roads/openai/openaiLimitState.ts')
  const transcript = await getCrewmateTranscript(agentId as never)
  check('the transcript retains the refusal and the resumed answer', transcript?.messages.some(row => row.type === 'assistant' && row.isApiErrorMessage === true) === true && JSON.stringify(transcript?.messages).includes('The provider served the resumed request.'), 'the agent transcript read by getAgentTranscript in src/sessions/transcripts/sessionListings.js must keep the api error row and the resumed answer after the resume')
} catch (error) {
  console.log(`FAIL agent fixture: ${error instanceof Error ? error.message : String(error)}`)
  failures++
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} provider decides (${failures} failures)`)
process.exit(failures ? 1 : 0)
