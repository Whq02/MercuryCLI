#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { rmSync } from 'node:fs'
import { z } from 'zod/v4'
import { nousFixture, NOUS_FIXTURE_API_KEY, NOUS_FIXTURE_FILLER_ROWS, NOUS_FIXTURE_INVALID_KEY_MESSAGE } from '../providers/lib/nous-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TOOL_DEFER = '1'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[name]
const fixture = nousFixture()
Object.assign(process.env, fixture.env)

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { declaredRouteOf, canonicalWireModelId, providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const cat = await import('../../src/services/providers/nous/nousCatalogue.ts')
const { resolveNousAccount } = await import('../../src/services/providers/nous/nousAccounts.ts')
const usageState = await import('../../src/services/providers/nous/nousUsageState.ts')
const { storeNousApiKeyLogin } = await import('../../src/services/providers/nous/nousLogin.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { getModelOptions, isCatalogueDoorRow } = await import('../../src/utils/model/modelOptions.ts')
const { resolveContextWindow, effortVocabularyFor, modelReceivesImageBlocks, getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const { validateModel } = await import('../../src/utils/model/validateModel.ts')
const { resolveEngineDispatch } = await import('../../src/utils/crew/engineDispatch.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Tool = import('../../src/Tool.ts').Tool
const fixtureRead = { name: 'FixtureRead', shouldDefer: false, prompt: async () => 'Read a fixture', description: async () => 'Read a fixture', inputSchema: z.object({ path: z.string() }), isEnabled: () => true, isConcurrencySafe: () => true, isReadOnly: () => true, userFacingName: () => 'FixtureRead', call: async () => ({ data: 'fixture' }) } as unknown as Tool

async function turn(model: string, prompt: string, opts: { tools?: boolean; effort?: string } = {}): Promise<{ captures: typeof fixture.requests; errors: string[]; settled: AssistantMessage[] }> {
  clearToolRosterLatches()
  const before = fixture.requests.length
  const errors: string[] = []
  const settled: AssistantMessage[] = []
  const messages: Message[] = [createUserMessage({ content: prompt })]
  for await (const item of routedCallModel({
    messages: messages as never,
    systemPrompt: ['Fixture system'] as never,
    thinkingConfig: { type: 'enabled', budgetTokens: 1024 } as never,
    tools: (opts.tools === false ? [] : [ToolSearchTool, fixtureRead]) as never,
    signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false, ...(opts.effort ? { effortValue: opts.effort } : {}) } as never,
  })) {
    if (item.type === 'assistant') {
      if (item.isApiErrorMessage) errors.push(item.message.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(''))
      else settled.push(item as AssistantMessage)
    }
  }
  return { captures: fixture.requests.slice(before), errors, settled }
}

try {
  console.log('── the id space: nous/<vendor>/<model> is a declared carrier namespace, the Portal slug rides the wire ──')
  check('nous/anthropic/claude-sonnet-4.6 routes to the nous family', declaredRouteOf('nous/anthropic/claude-sonnet-4.6') === 'nous')
  check("the Portal's ~vendor/<name>-latest alias rows fit the namespace", declaredRouteOf('nous/~anthropic/claude-sonnet-latest') === 'nous' && canonicalWireModelId('nous/~anthropic/claude-sonnet-latest').ok)
  const stripped = canonicalWireModelId('nous/anthropic/claude-sonnet-4.6')
  check('the namespace detaches for the wire', stripped.ok && stripped.wireId === 'anthropic/claude-sonnet-4.6')
  check('a bare Portal slug is not a nous id (unknown like any other carrier-shaped string)', declaredRouteOf('anthropic/claude-sonnet-4.6') === null)
  check('the display name is one owner', providerDisplayName('nous') === 'Nous Portal')

  console.log('── the key: NOUS_API_KEY resolves the account; the catalogue reads live through it ──')
  check('the env key resolves as the account', resolveNousAccount()?.label === 'NOUS_API_KEY (env)')
  const snapshot = await cat.refreshNousCatalogue({ force: true })
  check('the live list lands through the fixture', snapshot !== null && snapshot.models.length === 7 + NOUS_FIXTURE_FILLER_ROWS && snapshot.lastError === undefined, JSON.stringify({ n: snapshot?.models.length, err: snapshot?.lastError }))
  check('the models request carried the key as a bearer', fixture.requests.some(r => r.path === '/v1/models' && r.headers.authorization === `Bearer ${NOUS_FIXTURE_API_KEY}`))

  console.log('── the picker: recommended rows lead, the door opens the full list ──')
  const options = getModelOptions().filter(row => row.group === cat.NOUS_MODEL_GROUP)
  const modelRows = options.filter(row => row.value.startsWith('nous/'))
  check('the Portal-recommended agentic rows lead the group', modelRows[0]?.value === 'nous/anthropic/claude-sonnet-4.6' && modelRows[1]?.value === 'nous/openai/gpt-5.5-pro' && modelRows[2]?.value === 'nous/deepseek/deepseek-v4-pro', modelRows.slice(0, 4).map(r => r.value).join(','))
  check('the bounded view holds 24 rows and a door names the full count', modelRows.length === 24 && options.some(row => isCatalogueDoorRow(row.value) && row.catalogueDoor?.total === 7 + NOUS_FIXTURE_FILLER_ROWS), `${modelRows.length} rows`)
  check('a :batch variant sinks below the plain rows', modelRows.findIndex(r => r.value.endsWith(':batch')) === -1 || modelRows.findIndex(r => r.value.endsWith(':batch')) > modelRows.findIndex(r => r.value === 'nous/fixture/chat-only'))
  const full = cat.getNousFullModelOptions()
  check('the door lists every row, persisted as nous/<slug>', full.length === 7 + NOUS_FIXTURE_FILLER_ROWS && full.every(row => row.value.startsWith('nous/')))
  check('a row states its own context window to the picker', modelRows[0]?.statedContextWindow === 1000000)

  console.log('── the capability edge reads the live row, never a first-party table ──')
  check('the context window is the row\'s', resolveContextWindow('nous/anthropic/claude-sonnet-4.6').effectiveWindow === 1000000 && resolveContextWindow('nous/anthropic/claude-sonnet-4.6').source === 'live-current')
  check('an unstated output ceiling keeps the labelled default; a stated one is the row\'s', getModelMaxOutputTokens('nous/openai/gpt-5.5-pro').upperLimit === 128000)
  const effort = effortVocabularyFor('nous/openai/gpt-5.5-pro')
  check('the effort dial is the row\'s stated vocabulary', effort.kind === 'provider' && effort.source === 'nous' && JSON.stringify(effort.vocabulary) === JSON.stringify(['xhigh', 'high', 'medium']), JSON.stringify(effort))
  check('a row stating no reasoning offers no dial', effortVocabularyFor('nous/anthropic/claude-sonnet-4.6').kind === 'none')
  check('image input follows the row\'s input modalities', modelReceivesImageBlocks('nous/openai/gpt-5.5-pro') && !modelReceivesImageBlocks('nous/anthropic/claude-sonnet-4.6'))
  const price = resolveModelPricing('nous/anthropic/claude-sonnet-4.6')
  check('the price is the row\'s per-token statement, in USD per million', price.basis === 'recorded' && price.costs.inputTokens === 3 && price.costs.outputTokens === 15 && price.costs.promptCacheReadTokens === 0.3, JSON.stringify(price))

  console.log('── validation: a listed id passes, an unlisted one is refused before the wire ──')
  check('a listed nous id validates', (await validateModel('nous/anthropic/claude-sonnet-4.6')).valid)
  const unlisted = await validateModel('nous/anthropic/claude-nowhere-9')
  check('an unlisted nous id is refused with the catalogue words', !unlisted.valid && (unlisted.error ?? '').includes('not listed by the live Nous Portal catalogue'), unlisted.error)

  console.log('── a turn: the Portal slug, the bearer, the row\'s reasoning dial, tools, usage ──')
  fixture.state.toolCall = true
  const first = await turn('nous/openai/gpt-5.5-pro', 'Use the tool', { effort: 'high' })
  const request = first.captures.find(c => c.path === '/v1/chat/completions')
  check('the turn settles through the Portal chat road', first.errors.length === 0 && request !== undefined, JSON.stringify(first.errors))
  check('the wire carries the Portal slug and the bearer key', request?.body?.model === 'openai/gpt-5.5-pro' && request?.headers.authorization === `Bearer ${NOUS_FIXTURE_API_KEY}`, JSON.stringify(request?.body?.model))
  const reasoning = request?.body?.reasoning as { effort?: string } | undefined
  check('the reasoning dial rides as reasoning.effort from the row\'s vocabulary', reasoning?.effort === 'high', JSON.stringify(request?.body?.reasoning))
  check('stream_options asks for the usage chunk and the tools ride', JSON.stringify(request?.body?.stream_options) === JSON.stringify({ include_usage: true }) && Array.isArray(request?.body?.tools) && (request?.body?.tools as unknown[]).length > 0)
  const blocks = first.settled.flatMap(m => m.message.content)
  const text = blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  const toolUse = blocks.find(b => b.type === 'tool_use') as { name?: string; input?: unknown } | undefined
  check('the reply text and the tool call both settle', text.includes('OK from the Portal fixture') && toolUse?.name === 'FixtureRead' && JSON.stringify(toolUse?.input) === JSON.stringify({ path: 'README.md' }), JSON.stringify({ text, toolUse }))
  const usage = first.settled.at(-1)?.message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined
  check('the usage chunk settles with the cached-token count', usage !== undefined && usage.output_tokens === 18 && (usage.cache_read_input_tokens ?? 0) === 100, JSON.stringify(usage))
  check('the reasoning delta settles as thinking', blocks.some(b => b.type === 'thinking'))

  console.log('── the ~latest alias dispatches under its own slug ──')
  fixture.state.toolCall = false
  const alias = await turn('nous/~anthropic/claude-sonnet-latest', 'Say OK', { tools: false, effort: 'max' })
  const aliasRequest = alias.captures.find(c => c.path === '/v1/chat/completions')
  check('the alias row rides verbatim with its stated max effort', alias.errors.length === 0 && aliasRequest?.body?.model === '~anthropic/claude-sonnet-latest' && (aliasRequest?.body?.reasoning as { effort?: string } | undefined)?.effort === 'max', JSON.stringify({ errors: alias.errors, model: aliasRequest?.body?.model, reasoning: aliasRequest?.body?.reasoning }))

  console.log('── a row without tools refuses a tool-bearing turn before any request ──')
  const chatOnly = await turn('nous/fixture/chat-only', 'Use the tool')
  check('no request leaves for a tool-bearing turn on a tools-less row', chatOnly.captures.filter(c => c.path === '/v1/chat/completions').length === 0 && chatOnly.errors.some(e => e.includes('does not take tools')), JSON.stringify(chatOnly.errors))
  const chatOnlyPlain = await turn('nous/fixture/chat-only', 'Say OK', { tools: false })
  check('the same row answers a plain turn', chatOnlyPlain.errors.length === 0 && chatOnlyPlain.captures.some(c => c.path === '/v1/chat/completions'))

  console.log('── the Portal\'s 401 (invalid, blocked or out of funds) is a typed refusal naming the remedy, never another lane ──')
  fixture.state.chatStatus = 401
  const refused = await turn('nous/anthropic/claude-sonnet-4.6', 'Say OK', { tools: false })
  check('the refusal carries the Portal\'s own words and Mercury\'s remedy', refused.settled.length === 0 && refused.errors.length === 1 && refused.errors[0]!.includes(NOUS_FIXTURE_INVALID_KEY_MESSAGE.trim()) && /\/logins nous/.test(refused.errors[0]!) && /out of funds/.test(refused.errors[0]!), JSON.stringify(refused.errors))
  check('only the Portal was asked', refused.captures.every(c => c.path.startsWith('/v1/') || c.path === '/api/oauth/account'))
  fixture.state.chatStatus = 200

  console.log('── the meter: the Portal account endpoint, read with the key ──')
  usageState.__resetNousUsageForTest()
  await owner.refreshProviderUsage('nous', { force: true })
  const meter = owner.usageForProvider('nous')
  check('usable credits paint as the credits line', meter.sourceKind === 'api-key' && meter.credits.state === 'reported' && meter.credits.display === 'USD 42.50 usable credits', JSON.stringify(meter.credits))
  const figureKeys = (meter.figures ?? []).map(f => `${f.key}=${f.value}`)
  check('the plan, subscription credits, purchased credits and spend cap are figures', figureKeys.includes('plan=Plus (tier 2)') && figureKeys.includes('subscription-credits=USD 12.50 of 20.00 monthly') && figureKeys.includes('purchased-credits=USD 30.00') && figureKeys.includes('member-spend-cap=USD 7.25 of 100.00'), figureKeys.join(' | '))
  check('the account request carried the key as a bearer', fixture.requests.some(r => r.path === '/api/oauth/account' && r.headers.authorization === `Bearer ${NOUS_FIXTURE_API_KEY}`))
  check('the family reads usable', resolveProviderUsability().nous.usable)

  console.log('── a key the Portal does not resolve to an account: the honest reader note, never a fabricated figure ──')
  usageState.__resetNousUsageForTest()
  fixture.state.accountStatus = 401
  await owner.refreshProviderUsage('nous', { force: true })
  const unresolved = owner.usageForProvider('nous')
  check('credits read unreported with the endpoint\'s own answer in the note', unresolved.credits.state === 'unreported' && (unresolved.readerNote ?? '').includes('HTTP 401') && (unresolved.readerNote ?? '').includes('API key is not associated with a user account') && (unresolved.readerNote ?? '').includes('portal.nousresearch.com'), JSON.stringify({ credits: unresolved.credits, note: unresolved.readerNote }))
  fixture.state.accountStatus = 200

  console.log('── the key leg: the store receipt names the account when the Portal resolves the key ──')
  usageState.__resetNousUsageForTest()
  const stored = await storeNousApiKeyLogin(NOUS_FIXTURE_API_KEY)
  check('the receipt carries the plan and the usable credits, never the key', stored.ok && stored.stored && stored.receipt.includes('plan Plus (tier 2)') && stored.receipt.includes('USD 42.50 usable credits') && !stored.receipt.includes(NOUS_FIXTURE_API_KEY), stored.receipt)
  fixture.state.accountStatus = 401
  const storedUnresolved = await storeNousApiKeyLogin(NOUS_FIXTURE_API_KEY)
  check('a key the account endpoint does not confirm is still stored, and the receipt says the first turn proves it', storedUnresolved.stored && storedUnresolved.receipt.includes('did not confirm it (HTTP 401') && storedUnresolved.receipt.includes('the first turn proves the key'), storedUnresolved.receipt)
  fixture.state.accountStatus = 200

  console.log('── the engine grammar: the class word and an exact id ──')
  const classWord = await resolveEngineDispatch('nous')
  check("'nous' resolves to the Portal's first recommended live row", classWord?.backend === 'nous' && classWord.model === 'nous/anthropic/claude-sonnet-4.6', JSON.stringify(classWord))
  const exact = await resolveEngineDispatch('nous/openai/gpt-5.5-pro')
  check('an exact listed id dispatches on the nous backend', exact?.backend === 'nous' && exact.model === 'nous/openai/gpt-5.5-pro', JSON.stringify(exact))
  let unlistedExact: string | undefined
  try {
    await resolveEngineDispatch('nous/fixture/absent')
  } catch (error) {
    unlistedExact = error instanceof Error ? error.message : String(error)
  }
  check('an unlisted exact id is refused with the live count', (unlistedExact ?? '').includes('is not listed by the live catalogue'), unlistedExact)
} finally {
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(failures === 0 ? `\nNOUS KEY ROAD GREEN (${passes} checks; loopback fixture, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
