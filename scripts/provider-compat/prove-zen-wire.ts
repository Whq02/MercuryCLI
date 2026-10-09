import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import { startZenFixture } from '../providers/lib/zen-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const KEY = 'sk-proof-key-zen-fixture-wire-not-a-real-key-0000000000000000000000000000'
process.env.OPENCODE_API_KEY = KEY
const fixture = startZenFixture({ key: KEY })
process.env.MERCURY_ZEN_API_BASE = fixture.base
process.env.MERCURY_ZEN_GO_API_BASE = fixture.goBase
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel, classifyModelRoute } = await import('../../src/services/providers/callModelRouter.ts')
const { canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
const { resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.ts')
const { refreshZenCatalogue, zenCatalogueRows, cachedLiveIds, __resetZenCatalogueForTest } = await import('../../src/services/providers/zen/zenCatalogue.ts')
const { buildZenExtras } = await import('../../src/services/providers/zen/zenCallModel.ts')
const { zenServedShapeOf, ZEN_DISPLAY_PINS } = await import('../../src/services/providers/zen/zenPins.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { laneBillingState } = await import('../../src/services/providers/laneBillingState.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const tool = { name: 'FixtureEcho', description: async () => 'Echo fixture', prompt: async () => 'Echo fixture', inputSchema: z.object({ text: z.string() }), userFacingName: () => 'FixtureEcho', isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, isMcp: false, needsPermissions: () => false } as never
function params(model: string, effortValue: string | undefined = 'max', thinking = true, messages: Message[] = [createUserMessage({ content: 'hello fixture' })]): CompatCallModelParams {
  return { messages, tools: [tool], systemPrompt: asSystemPrompt(['Fixture system']), thinkingConfig: thinking ? { type: 'enabled', budgetTokens: 4096 } : { type: 'disabled' }, signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue, maxOutputTokensOverride: 512 } as never }
}
async function run(p: CompatCallModelParams): Promise<AssistantMessage[]> {
  const settled: AssistantMessage[] = []
  for await (const event of routedCallModel(p as never)) if (event.type === 'assistant') settled.push(event as AssistantMessage)
  return settled
}
const text = (rows: AssistantMessage[]): string => rows.flatMap(row => row.message.content).map(block => block.type === 'text' ? block.text : '').join('')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('zen/<id> is a declared qualified namespace that strips to the vendor id', classifyModelRoute('zen/glm-5.3').kind === 'route' && (classifyModelRoute('zen/glm-5.3') as { route: string }).route === 'zen' && canonicalWireModelId('zen/glm-5.3').ok && (canonicalWireModelId('zen/glm-5.3') as { wireId: string }).wireId === 'glm-5.3')
  check('a bare gateway id keeps its native family: glm-5.3 is Z.AI, gpt-5.5 is OpenAI', (classifyModelRoute('glm-5.3') as { route: string }).route === 'zai' && (classifyModelRoute('gpt-5.5') as { route: string }).route === 'openai')
  check('every pinned id is served in a shape this road carries, and 60 are pinned', ZEN_DISPLAY_PINS.length === 60 && ZEN_DISPLAY_PINS.every(pin => pin.shape === zenServedShapeOf(pin.id)))
  check('the shape law reads the vendor table: Claude and Qwen 3.7 ride Anthropic, Gemini rides Google, Jev rides System One', zenServedShapeOf('claude-fable-5-1') === 'anthropic' && zenServedShapeOf('qwen3.7-max') === 'anthropic' && zenServedShapeOf('gemini-3.1-pro') === 'google' && zenServedShapeOf('jev-1.13') === 'systemone' && zenServedShapeOf('fixture-unpinned-model') === 'chat')
  check('the key configures a Zen backend but is not a claimed live turn', resolvePrimaryAgentBackend('zen/glm-5.3')?.id === 'zen-gateway' && resolvePrimaryAgentBackend('zen/glm-5.3')?.readiness().state === 'configured' && resolveProviderUsability().zen.usable)
  await refreshZenCatalogue({ force: true })
  const rows = zenCatalogueRows().rows
  check('the live list lands as the dispatchable rows only, free rows last', fixture.listReads === 1 && rows.map(row => row.id).join(' ') === 'glm-5.3 glm-5 kimi-k3 mistral-large-4 fixture-unpinned-model gpt-5.5 grok-4.7 big-pickle' && rows.find(row => row.id === 'big-pickle')?.free === true)
  check('ids the gateway serves in other shapes are simply not listed', !cachedLiveIds().has('claude-fable-5-1') && !cachedLiveIds().has('gemini-3.1-pro') && !cachedLiveIds().has('qwen3.7-max') && !cachedLiveIds().has('jev-1.13'))
  const chat = await run(params('zen/glm-5.3'))
  const first = fixture.captures[0]!
  check('a chat-shaped id rides POST /zen/v1/chat/completions with the bare vendor id and the Bearer key', first.path === '/zen/v1/chat/completions' && first.body.model === 'glm-5.3' && first.headers.authorization === `Bearer ${KEY}`)
  check("every request carries Mercury's own user agent and the session id the vendor asks for", /^mercury\//i.test(first.headers['user-agent'] ?? '') && first.headers['x-opencode-session'] === getSessionId())
  check('chat request carries streaming usage, function tools and the pinned effort vocabulary', first.body.stream && first.body.stream_options.include_usage && first.body.tools[0].function.name === 'FixtureEcho' && first.body.reasoning_effort === 'max' && first.body.max_completion_tokens === 512 && !('thinking' in first.body))
  check('visible text and the usage settle, and the trailing cost chunk after [DONE] disturbs nothing', text(chat).includes('ZEN-CHAT-SETTLED') && chat.at(-1)?.message.usage?.output_tokens === 103 && chat.at(-1)?.message.usage?.cache_read_input_tokens === 4 && !chat.some(row => row.isApiErrorMessage))
  check('a settled turn alone advances the readiness receipt', resolvePrimaryAgentBackend('zen/glm-5.3')?.readiness().state === 'ready')
  await run(params('zen/glm-5', 'max', false))
  check('a thinking-toggle model sends the documented thinking switch and no effort word', fixture.captures.at(-1)?.body.thinking?.type === 'disabled' && !('reasoning_effort' in fixture.captures.at(-1)!.body))
  await run(params('zen/kimi-k3', 'high'))
  check("Kimi K3 clamps to its documented vocabulary ('max' only)", fixture.captures.at(-1)?.body.reasoning_effort === 'max')
  check('an unpinned live id sends no invented effort or ceiling', JSON.stringify(buildZenExtras({ wireModel: 'fixture-unpinned-model', effortValue: 'max', thinkingEnabled: true, maxOutputTokensOverride: undefined })) === '{"stream_options":{"include_usage":true}}')
  const responses = await run(params('zen/gpt-5.5', 'high'))
  const resp = fixture.captures.at(-1)!
  check('a Responses-shaped id rides POST /zen/v1/responses stateless with encrypted reasoning asked for', resp.path === '/zen/v1/responses' && resp.body.model === 'gpt-5.5' && resp.body.store === false && resp.body.include?.[0] === 'reasoning.encrypted_content' && resp.body.stream === true && resp.body.reasoning?.effort === 'high' && resp.body.max_output_tokens === 512)
  check('Responses tools are flat function objects with the Bearer key and the session header', resp.body.tools[0].type === 'function' && resp.body.tools[0].name === 'FixtureEcho' && resp.headers.authorization === `Bearer ${KEY}` && resp.headers['x-opencode-session'] === getSessionId())
  check('the Responses text settles with its usage and the trailing cost ping disturbs nothing', text(responses).includes('ZEN-RESPONSES-SETTLED') && responses.at(-1)?.message.usage?.input_tokens !== undefined && !responses.some(row => row.isApiErrorMessage))
  check('the settled Responses turn records its replay items on the Zen record, not another family\'s', responses.at(-1)?.zenProviderTurn?.model === 'gpt-5.5' && (responses.at(-1)?.zenProviderTurn?.items.length ?? 0) > 0 && responses.at(-1)?.openrouterProviderTurn === undefined && responses.at(-1)?.xaiProviderTurn === undefined)
  await run(params('zen/gpt-5.5', 'high', true, [...responses.map(row => ({ ...row })), createUserMessage({ content: 'and again' })]))
  const replay = fixture.captures.at(-1)!.body.input as Array<Record<string, unknown>>
  check('the next turn replays the recorded encrypted reasoning in order', replay.some(item => item.type === 'reasoning' && item.encrypted_content === 'ENCRYPTED-FIXTURE-REASONING'))
  fixture.mode = 'tools'
  const chatTools = await run(params('zen/glm-5.3'))
  const chatCalls = chatTools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('fragmented chat tool arguments become one validated call', chatCalls.length === 1 && chatCalls[0]?.type === 'tool_use' && chatCalls[0].id === 'call_zen_fixture' && JSON.stringify(chatCalls[0].input) === '{"text":"hello"}')
  const respTools = await run(params('zen/grok-4.7'))
  const respCalls = respTools.flatMap(row => row.message.content).filter(block => block.type === 'tool_use')
  check('a Responses function call settles once as an executable tool_use', respCalls.length === 1 && respCalls[0]?.type === 'tool_use' && JSON.stringify(respCalls[0].input) === '{"text":"hello"}')
  fixture.mode = 'text'
  await run(params('zen/glm-5.3', 'high', true, [...chatTools, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_zen_fixture', content: 'echo:hello' }] })]))
  const history = fixture.captures.at(-1)!.body.messages as Array<Record<string, any>>
  check('chat tool results replay with the matching assistant call', history.some(row => row.role === 'assistant' && row.tool_calls?.[0]?.id === 'call_zen_fixture') && history.some(row => row.role === 'tool' && row.tool_call_id === 'call_zen_fixture'))
  fixture.mode = 'malformed'
  check('malformed tool JSON cannot become an executable call on either shape', !(await run(params('zen/glm-5.3'))).some(row => row.message.content.some(block => block.type === 'tool_use')) && !(await run(params('zen/gpt-5.5'))).some(row => row.message.content.some(block => block.type === 'tool_use')))
  fixture.mode = 'truncated'
  check('an unterminated stream is not success on either shape', (await run(params('zen/glm-5.3'))).some(row => row.isApiErrorMessage) && (await run(params('zen/gpt-5.5'))).some(row => row.isApiErrorMessage))
  fixture.mode = 'auth'
  const auth = await run(params('zen/glm-5.3'))
  check("the gateway's AuthError refuses once with the /logins zen remedy", auth.some(row => row.isApiErrorMessage && row.error === 'authentication_failed' && JSON.stringify(row).includes('/logins zen')))
  fixture.mode = 'credits'
  const credits = await run(params('zen/glm-5.3'))
  check("the gateway's CreditsError (sent as HTTP 401) is a billing refusal naming the console, never a key problem", credits.some(row => row.isApiErrorMessage && row.error === 'billing_error' && JSON.stringify(row).includes('opencode.ai/auth')) && laneBillingState('zen').state === 'credit-exhausted')
  fixture.mode = 'monthly-limit'
  check("the gateway's MonthlyLimitError is a billing refusal too", (await run(params('zen/gpt-5.5'))).some(row => row.isApiErrorMessage && row.error === 'billing_error'))
  fixture.mode = 'text'
  await run(params('zen/glm-5.3'))
  check('a served turn clears the remembered billing refusal', laneBillingState('zen').state === 'clear')
  fixture.mode = 'go-limit'
  const limited = await run(params('zen/glm-5.3'))
  check("a Go window reached (429 + retry-after) is a rate limit carrying the vendor's wait", limited.some(row => row.isApiErrorMessage && row.error === 'rate_limit' && /GoUsageLimitError|weekly/i.test(JSON.stringify(row))))
  fixture.mode = 'text'
  const before = fixture.captures.length
  check('an id outside the list refuses before any request, like any unlisted id', (await run(params('zen/claude-fable-5-1'))).some(row => row.isApiErrorMessage && row.error === 'invalid_request') && (await run(params('zen/not-a-model'))).some(row => row.isApiErrorMessage && row.error === 'invalid_request') && fixture.captures.length === before)
  check('the refusal carries no bespoke words about shapes or this build', !(await run(params('zen/claude-fable-5-1'))).some(row => /shape|this build/i.test(JSON.stringify(row))))
  const dispatch = await resolveEngineDispatch('zen/glm-5.3')
  check('a crewmate dispatch on an exact zen/ id is catalogue-verified onto the zen backend', dispatch?.backend === 'zen' && dispatch.model === 'zen/glm-5.3')
  let refused = false
  try { await resolveEngineDispatch('zen/claude-fable-5-1') } catch { refused = true }
  check('a crewmate dispatch on an unlisted zen/ id refuses', refused)
  fixture.modelList = []
  await refreshZenCatalogue({ force: true })
  const emptyBefore = fixture.captures.length
  check('an empty live list refuses every id rather than sending a pin', (await run(params('zen/glm-5.3'))).some(row => row.isApiErrorMessage) && fixture.captures.length === emptyBefore)
  await refreshZenCatalogue({ force: true, fetchImpl: (async () => Response.json({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }, { status: 401 })) as typeof fetch })
  check('a refused catalogue read is an authentication refusal with the /logins zen remedy', (await run(params('zen/glm-5.3'))).some(row => row.isApiErrorMessage && row.error === 'authentication_failed' && JSON.stringify(row).includes('/logins zen')) && fixture.captures.length === emptyBefore)
  __resetZenCatalogueForTest()
  const aborted = new AbortController(); aborted.abort()
  check('pre-aborted calls return quietly without a request', (await run({ ...params('zen/glm-5.3'), signal: aborted.signal })).length === 0 && fixture.captures.length === emptyBefore)
  console.log(`ZEN WIRE GREEN (${count} checks; loopback fixture only)`)
} finally { fixture.stop(); rmSync(proofHome, { recursive: true, force: true }) }
