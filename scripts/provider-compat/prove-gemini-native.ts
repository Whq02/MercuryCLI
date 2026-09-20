import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'gemini-native-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://gemini.fixture.invalid/token'
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET']) delete process.env[name]
const access = 'ya29.fixture-native-access'
const refreshed = 'ya29.fixture-native-refreshed'
const key = 'fixture-gemini-key'
function seed(source: 'oauth' | 'api-key' = 'oauth'): void {
  writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: source, client: { clientId: 'fixture-client' }, tokens: { accessToken: access, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }))
}
seed()
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { geminiCallModel, geminiLaneProfile, geminiLiveProofState, GEMINI_ACCOUNT_BILLING_REMEDY } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getUsageForModel } = await import('../../src/bootstrap/state.ts')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.ts')
const { foldSplitTurnsForWire } = await import('../../src/utils/messages/pairing.ts')
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let checks = 0
let failures = 0
function check(label: string, condition: boolean): void {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}`)
}
const model = 'gemini-3.5-flash'
const tool = { name: 'FixtureEcho', prompt: async () => 'Echo the supplied text.', inputSchema: z.object({ text: z.string(), optional: z.string().optional() }), inputJSONSchema: { type: 'object', properties: { text: { type: 'string' }, optional: { type: 'string' } }, required: ['text'] } }
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(messages: Message[], withTools = false): CompatCallModelParams {
  return {
    messages, systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: withTools ? [tool] as never : [], signal: new AbortController().signal,
    options: { model, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
  }
}
async function drain(input: CompatCallModelParams): Promise<AssistantMessage[]> {
  const out: AssistantMessage[] = []
  for await (const item of geminiCallModel(input)) if (item.type === 'assistant') out.push(item)
  return out
}
const text = (messages: AssistantMessage[]) => messages.flatMap(message => message.message.content).filter(block => block.type === 'text').map(block => block.text).join('')
function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
type Hit = { url: string; auth: string | null; body: Record<string, any> }
const hits: Hit[] = []
let scenario: 'text' | 'tools' | 'tool-result' | 'refused-tool' | 'refuse' | 'refresh' | 'overflow' | 'rate' | 'overload' | 'billing' = 'text'
const overloadReason = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (!url.startsWith('https://gemini.fixture.invalid/')) throw new Error('unpinned Gemini request')
  const auth = new Headers(init?.headers).get('authorization')
  if (url.endsWith('/token')) {
    hits.push({ url, auth, body: {} })
    return Response.json({ access_token: refreshed, expires_in: 3600 })
  }
  const body = JSON.parse(String(init?.body ?? '{}'))
  hits.push({ url, auth, body })
  if (url.endsWith('/openai/chat/completions')) {
    if (auth === `Bearer ${key}`) return sse([{ choices: [{ delta: { content: 'key answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }])
    return Response.json([{ error: { code: 401, status: 'UNAUTHENTICATED', message: 'the compatibility fixture accepts API keys only' } }], { status: 401 })
  }
  if (!url.endsWith(`/models/${model}:streamGenerateContent?alt=sse`)) return Response.json({ error: { message: 'wrong native URL' } }, { status: 404 })
  if (scenario === 'refuse' || (scenario === 'refresh' && auth !== `Bearer ${refreshed}`)) return Response.json({ error: { code: 401, status: 'UNAUTHENTICATED', message: `rejected ${auth}` } }, { status: 401 })
  if (scenario === 'overflow') return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1000000)' } }, { status: 400 })
  if (scenario === 'rate') return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota reached' } }, { status: 429, headers: { 'retry-after': '600' } })
  if (scenario === 'overload') return Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: overloadReason } }, { status: 503 })
  if (scenario === 'billing') return Response.json({ error: { code: 402, message: 'payment is required' } }, { status: 402 })
  if (scenario === 'refused-tool') return sse([
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'NoSuchTool', args: { text: 'x' } }, thoughtSignature: 'fixture-refused-signature' }, { functionCall: { name: 'FixtureEcho', args: { text: 'ok' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
  ])
  if (scenario === 'tools') return sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Using the tool.' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'native-call', name: 'FixtureEcho', args: { text: 'hello', optional: '' } }, thoughtSignature: 'fixture-tool-signature' }, { functionCall: { name: 'FixtureEcho', args: { text: 'again' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 4, candidatesTokenCount: 5, thoughtsTokenCount: 7 } },
  ])
  return sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: scenario === 'tool-result' ? 'tool result received' : 'native answer' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'fixture-text-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 4, candidatesTokenCount: 5, thoughtsTokenCount: 7 } },
  ])
}) as typeof fetch
try {
  const first = await drain(params([user('Say hello.')]))
  check('OAuth answers through native streaming content, never compatibility', text(first) === 'native answer' && hits.some(hit => hit.url.endsWith(':streamGenerateContent?alt=sse')) && !hits.some(hit => hit.url.includes('/openai/')))
  const request = hits.find(hit => hit.url.endsWith(':streamGenerateContent?alt=sse'))
  check('native request carries bearer, system instruction, user parts and output ceiling', request?.auth === `Bearer ${access}` && request?.body.contents?.[0]?.parts?.[0]?.text === 'Say hello.' && request?.body.systemInstruction?.parts.length > 0 && request?.body.generationConfig?.maxOutputTokens === 64 && request?.body.messages === undefined)
  const usage = first.at(-1)?.message.usage
  check('usage excludes cached input and includes thought output exactly once', usage?.input_tokens === 16 && usage.cache_read_input_tokens === 4 && usage.output_tokens === 12)
  check('native success sets the existing earned-ready state', geminiLiveProofState()?.model === model)
  check('the session ledger receives native usage', (getUsageForModel(model)?.outputTokens ?? 0) >= 12)
  const record = (first.at(-1) as any)?.geminiProviderTurn
  check('a streamed signature that arrives in an empty text part rides the reply text, with no empty part recorded', JSON.stringify(record?.parts) === JSON.stringify([{ text: 'native answer', thoughtSignature: 'fixture-text-signature' }]))
  hits.length = 0
  await drain(params([user('Say hello.'), ...first, user('And again.')]))
  const replayed = hits.find(hit => hit.body.contents)?.body.contents as any[] | undefined
  check('the next request replays the signed text part exactly as recorded', JSON.stringify(replayed?.[1]) === JSON.stringify({ role: 'model', parts: [{ text: 'native answer', thoughtSignature: 'fixture-text-signature' }] }) && replayed?.[2]?.parts?.[0]?.text === 'And again.')

  scenario = 'refused-tool'
  hits.length = 0
  const refusedTurn = await drain(params([user('Call an unknown tool.')], true))
  const refusedRecord = (refusedTurn.at(-1) as any)?.geminiProviderTurn
  const refusedBlocks = refusedTurn.flatMap(message => message.message.content).filter(block => block.type === 'tool_use')
  check('a call the gate refuses mints no tool_use and is recorded as refused beside the accepted call', refusedBlocks.length === 1 && refusedRecord?.refused?.length === 1 && refusedRecord.calls.length === 2)
  if (refusedBlocks.length === 1) {
    hits.length = 0
    scenario = 'tool-result'
    await drain(params([user('Call an unknown tool.'), ...refusedTurn, user([{ type: 'tool_result', tool_use_id: refusedBlocks[0]!.id, content: 'echo result' }])], true))
    const contents = hits.find(hit => hit.body.contents)?.body.contents as any[] | undefined
    const answers = contents?.[2]?.parts ?? []
    check('every recorded function call receives a response in call order, the refused one carrying its reason', contents?.[1]?.role === 'model' && contents[1].parts.length === 2 && answers.length === 2 && answers[0]?.functionResponse?.response?.error !== undefined && answers[1]?.functionResponse?.response?.output === 'echo result')
  } else {
    check('every recorded function call receives a response in call order, the refused one carrying its reason', false)
  }

  scenario = 'tools'
  hits.length = 0
  const toolTurn = await drain(params([user('Use both calls.')], true))
  const blocks = toolTurn.flatMap(message => message.message.content).filter(block => block.type === 'tool_use')
  check('parallel native calls settle once each, generating an id only when absent', blocks.length === 2 && blocks[0]?.id === 'native-call' && Boolean(blocks[1]?.id) && blocks[1]?.id !== blocks[0]?.id)
  check('the common input gate still drops an empty optional argument', blocks.length > 0 && !('optional' in (blocks[0]!.input as Record<string, unknown>)))
  const toolsRequest = hits.find(hit => hit.body.tools)?.body
  check('native function declarations retain the existing JSON schemas', toolsRequest?.tools?.[0]?.functionDeclarations?.[0].name === 'FixtureEcho' && toolsRequest?.tools?.[0]?.functionDeclarations?.[0].parametersJsonSchema.required.includes('text'))
  if (blocks.length === 2) {
    scenario = 'tool-result'
    hits.length = 0
    let ordinal = 0
    const persisted = toolTurn.map(message => {
      const record = entryToRecord(message as unknown as Record<string, unknown>, {
        sessionId: 'fixture-session' as never,
        nextOrdinal: () => String(++ordinal) as never,
        observedAt: new Date().toISOString(),
        source: { channel: 'sdk' },
      })
      return recordToEntry(JSON.parse(JSON.stringify(record))) as unknown as AssistantMessage
    })
    check('the real transcript codec preserves the native replay record without a writer change', JSON.stringify((persisted.at(-1) as any).geminiProviderTurn) === JSON.stringify((toolTurn.at(-1) as any).geminiProviderTurn))
    const results = user(blocks.map(block => ({ type: 'tool_result', tool_use_id: block.id, content: 'echo result' })))
    const follow = await drain(params([user('Use both calls.'), ...persisted, results], true))
    const next = hits.find(hit => hit.body.contents)?.body.contents as any[] | undefined
    const modelParts = next?.find(content => content.role === 'model')?.parts ?? []
    const responses = next?.filter(content => content.role === 'user').flatMap(content => content.parts).filter(part => part.functionResponse) ?? []
    check('stored signed tool parts survive split-turn folding and next request', modelParts.some((part: any) => part.thoughtSignature === 'fixture-tool-signature' && part.functionCall.args.optional === ''))
    check('function results pair native ids and names, including a call without native id', responses.length === 2 && responses[0].functionResponse.id === 'native-call' && responses[1].functionResponse.id === undefined && responses.every((part: any) => part.functionResponse.name === 'FixtureEcho'))
    check('a complete tool round receives the next native answer', text(follow) === 'tool result received')
    const folded = foldSplitTurnsForWire(persisted as never)
    check('the split-turn reader carries the settled native record', folded.length === 1 && Boolean((folded[0] as any).geminiProviderTurn))
  } else {
    check('stored signed tool parts survive split-turn folding and next request', false)
    check('function results pair native ids and names, including a call without native id', false)
    check('a complete tool round receives the next native answer', false)
    check('the split-turn reader carries the settled native record', false)
  }

  seed('api-key')
  process.env.GEMINI_API_KEY = key
  scenario = 'text'
  hits.length = 0
  const keyAnswer = await drain(params([user('Say hello.')]))
  check('API keys retain compatibility without a token refresh', text(keyAnswer) === 'key answer' && hits.length === 1 && hits[0]!.url.endsWith('/openai/chat/completions') && hits[0]!.auth === `Bearer ${key}`)
  delete process.env.GEMINI_API_KEY
  seed()
  scenario = 'refresh'
  hits.length = 0
  const recovered = await drain(params([user('Say hello.')]))
  check('a native authentication refusal refreshes once and retries natively', text(recovered) === 'native answer' && hits.filter(hit => hit.url.endsWith('/token')).length === 1 && hits.filter(hit => hit.url.includes(':streamGenerateContent')).length === 2)
  seed()
  scenario = 'refuse'
  hits.length = 0
  const refused = await drain(params([user('Say hello.')]))
  const refusal = text(refused)
  check('a repeated native 401 names the Google account and truthful retry, never an API key', refusal.includes("the Google account's token was refused (HTTP 401)") && refusal.includes('/logins re-connects the Google account') && refusal.includes('refreshed and the call retried once') && !refusal.includes('API_KEY') && !refusal.includes(access) && !refusal.includes(refreshed))
  check("Google's own reason rides third in the compat detail shape, the bearer masked out of it", refusal.endsWith('before this refusal. The wire said: api-UNAUTHENTICATED: rejected Bearer «masked»') && refusal.includes('retried once') && refusal.indexOf('The wire said') > refusal.indexOf('retried once'))
  scenario = 'overflow'
  const overflow = await drain(params([user('Say hello.')]))
  check('native context overflow retains the typed compaction signal', overflow.some(message => message.overflowSignal !== undefined && message.overflowSignal !== null))
  scenario = 'rate'
  hits.length = 0
  const rate = await drain(params([user('Say hello.')]))
  check('a provider wait outside the retry budget is not slept or retried', hits.length === 1 && rate.some(message => message.error === 'rate_limit' && typeof message.providerWaitEndsAtMs === 'number'))
  scenario = 'overload'
  hits.length = 0
  process.env.MERCURY_BUSY_RETRY_SCALE = '0.01'
  const overloaded = await drain(params([user('Say hello.')]))
  delete process.env.MERCURY_BUSY_RETRY_SCALE
  const overloadWords = overloaded.filter(message => message.isApiErrorMessage).map(message => text([message]))
  check("a native 503 that never clears is retried on the shared runtime's busy ladder (six retries, scaled by the product's own seam), then carries the ladder's sentence and its overload words with Google's reason", hits.length === 7 && /^API Error: Gemini stayed busy through 6 retries over \d+ s — Gemini stream failed \(api-UNAVAILABLE\) — /.test(overloadWords.at(-1) ?? '') && (overloadWords.at(-1) ?? '').endsWith(overloadReason) && overloadWords.length === 1 && overloaded.some(message => message.error === 'server_error'))
  scenario = 'billing'
  const billed = text(await drain(params([user('Say hello.')])))
  check('a native billing refusal names the Google sign-in remedy, the API-key form unchanged', billed.endsWith(`— ${GEMINI_ACCOUNT_BILLING_REMEDY}`) && billed.includes('out of credit (http-402: payment is required)') && geminiLaneProfile.billingRemedy!.includes('behind this key'))
} finally {
  globalThis.fetch = realFetch
}
const sharedRuntime = readFileSync(new URL('../../src/services/providers/openaicompat/compatChatCallModel.ts', import.meta.url), 'utf8')
check('an absent native hook selects the existing compatibility client unchanged', sharedRuntime.includes('const events = transport?.events ?? streamCompatChat(streamOptions)'))
const { streamGeminiContent } = await import('../../src/services/providers/gemini/geminiClient.ts')
const { buildGeminiRequest } = await import('../../src/services/providers/gemini/geminiCodec.ts')
async function client(fetchImpl: typeof fetch, extras: Record<string, unknown> = {}) {
  const events: any[] = []
  const turns: any[] = []
  for await (const event of streamGeminiContent({ apiKey: access, url: `https://gemini.fixture.invalid/v1beta/models/${model}:streamGenerateContent?alt=sse`, request: { model, messages: [{ role: 'user', content: 'hello' }] }, messages: [], fetchImpl, idleTimeoutMs: 40, onTurn: turn => { turns.push(turn) }, ...extras })) events.push(event)
  return { events, turns }
}
const responseFetch = (response: Response) => (async () => response) as typeof fetch
const plain = await client(responseFetch(Response.json({ candidates: [{ content: { parts: [{ text: 'plain reply', thoughtSignature: 'plain-signature' }] }, finishReason: 'STOP' }] })), { stream: false })
check('the non-streamed native road decodes a complete JSON reply', plain.events.some(event => event.type === 'text-delta' && event.text === 'plain reply') && plain.events.some(event => event.type === 'finish') && plain.turns[0]?.parts[0]?.thoughtSignature === 'plain-signature')
const truncated = await client(responseFetch(sse([{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }])))
check('EOF without finishReason is a typed truncation, never success', truncated.events.some(event => event.fault?.code === 'no-finish') && !truncated.events.some(event => event.type === 'finish'))
const malformed = await client(responseFetch(new Response('data: {bad\n\n', { headers: { 'content-type': 'text/event-stream' } })))
check('malformed streamed JSON is refused without leaking its bytes', malformed.events.some(event => event.fault?.code === 'bad-json-chunk') && malformed.turns.length === 0)
const blocked = await client(responseFetch(sse([{ promptFeedback: { blockReason: 'SAFETY' } }])))
check('a blocked prompt is a provider refusal, not an empty successful turn', blocked.events.some(event => event.fault?.code === 'finish:SAFETY') && !blocked.events.some(event => event.type === 'finish'))
const duplicate = await client(responseFetch(sse([{ candidates: [{ content: { parts: [{ functionCall: { id: 'same', name: 'FixtureEcho', args: {} } }, { functionCall: { id: 'same', name: 'FixtureEcho', args: {} } }] }, finishReason: 'STOP' }] }])))
check('duplicate native function ids never execute twice', duplicate.events.some(event => event.fault?.code === 'duplicate-tool-call') && !duplicate.events.some(event => event.type === 'finish'))
const idle = await client(responseFetch(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })))
check('an idle native stream uses the existing bounded watchdog', idle.events.some(event => event.fault?.code === 'idle-timeout'))
const controller = new AbortController()
controller.abort()
let cancelledFetches = 0
const cancelled = await client((async () => { cancelledFetches++; throw new Error('should not fetch') }) as typeof fetch, { signal: controller.signal })
check('an already-cancelled native call sends no request', cancelledFetches === 0 && cancelled.events.every(event => event.fault?.kind === 'cancelled'))
let selectedUrl = ''
let selectedSignal: AbortSignal | undefined
await client((async (url: unknown, init?: RequestInit) => { selectedUrl = String(url); selectedSignal = init?.signal ?? undefined; return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) }) as typeof fetch, { stream: false })
check('the non-streamed selector uses generateContent and releases its transport', selectedUrl.endsWith(':generateContent') && selectedSignal?.aborted === true)
const image = buildGeminiRequest({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], extra: { reasoning_effort: 'medium', max_tokens: 512 } }, [])
check('native images preserve their bytes and the selected effort/output limit', image.contents[0]?.parts[1]?.inlineData?.data === 'AA==' && image.generationConfig?.thinkingConfig?.thinkingLevel === 'MEDIUM' && image.generationConfig.maxOutputTokens === 512)
const legacyEffort = buildGeminiRequest({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hello' }], extra: { reasoning_effort: 'medium' } }, [])
check('the older native thinking dialect keeps the documented equivalent budget', legacyEffort.generationConfig?.thinkingConfig?.thinkingBudget === 8192)
check('without an effort word the provider default governs: no thinking configuration is sent', buildGeminiRequest({ model, messages: [{ role: 'user', content: 'hello' }] }, []).generationConfig === undefined)
const importedHistory = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'FixtureEcho', arguments: '{"text":"x"}' } }, { id: 'b', type: 'function', function: { name: 'FixtureEcho', arguments: '{"text":"y"}' } }] },
  { role: 'tool', tool_call_id: 'b', content: 'second' },
  { role: 'tool', tool_call_id: 'a', content: 'first' },
] as const
const imported = buildGeminiRequest({ model, messages: [...importedHistory] as never }, [])
check('history with no signed record takes the documented skip-validation signature on the first call only', imported.contents[1]?.parts[0]?.thoughtSignature === 'skip_thought_signature_validator' && imported.contents[1]?.parts[1]?.thoughtSignature === undefined)
check('function responses follow their calls in call order, never the result order', imported.contents[2]?.parts.map(part => part.functionResponse?.response.output).join(',') === 'first,second')
check('a model that does not validate signatures gets no placeholder', buildGeminiRequest({ model: 'gemini-2.5-pro', messages: [...importedHistory] as never }, []).contents[1]?.parts[0]?.thoughtSignature === undefined)
let codecFetches = 0
const codecFault = await client((async () => { codecFetches++; throw new Error('should not fetch') }) as typeof fetch, { request: { model, messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] } })
check('a request the codec cannot build is a typed non-retryable fault with no request sent', codecFetches === 0 && codecFault.events.some(event => event.fault?.code === 'gemini-request-codec' && event.fault.retryable === false && event.fault.kind === 'api-error'))
const twoSignatures = await client(responseFetch(sse([{ candidates: [{ content: { parts: [{ text: '' }, { text: 'first', thoughtSignature: 'sig-1' }] } }] }, { candidates: [{ content: { parts: [{ thoughtSignature: 'sig-2' }] }, finishReason: 'STOP' }] }])))
check('a second signature after a signed part keeps its own part and an unsigned empty part is dropped', JSON.stringify(twoSignatures.turns[0]?.parts) === JSON.stringify([{ text: 'first', thoughtSignature: 'sig-1' }, { text: '', thoughtSignature: 'sig-2' }]))
const thoughts = await client(responseFetch(sse([{ candidates: [{ content: { parts: [{ text: 'plan ', thought: true }, { text: 'more', thought: true }, { text: 'answer' }] } }] }, { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'sig-3' }] }, finishReason: 'STOP' }] }])))
check('thought parts merge apart from visible text and the closing signature rides the visible text', JSON.stringify(thoughts.turns[0]?.parts) === JSON.stringify([{ text: 'plan more', thought: true }, { text: 'answer', thoughtSignature: 'sig-3' }]) && thoughts.events.filter(event => event.type === 'reasoning-delta').length === 2)
const earlier = { type: 'assistant', message: { id: 'shared-turn', content: [] } } as unknown as AssistantMessage
const later = { ...earlier, apexProviderTurn: { provider: 'openai', items: [{ type: 'message' }] }, geminiProviderTurn: { model, parts: [], calls: [], projection: '' } } as AssistantMessage
const folded = foldSplitTurnsForWire([earlier, later]) as AssistantMessage[]
check('the additive replay copy leaves the existing OpenAI record copy intact', folded[0]?.apexProviderTurn === later.apexProviderTurn && folded[0]?.geminiProviderTurn === later.geminiProviderTurn)
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
