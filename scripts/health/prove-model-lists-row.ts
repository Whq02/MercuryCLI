#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync('/private/tmp/mw/doctor-model-lists-row-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_DEEPSEEK_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1'
for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'CI', 'NODE_ENV', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3, theme: 'dark', customApiKeyResponses: { approved: ['proof-key-ci-gate-not-a-real-key'.slice(-20)], rejected: [] } }))
writeFileSync(join(HOME, 'settings.json'), '{}')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const typedModelIds = await import('../../src/services/providers/typedModelIds.ts')
const { composeModelListsRow, judgeTypedIds, modelListFamilyLines, readModelListFacts, MODEL_LISTS_FIX, MODEL_LISTS_UNREAD_EVIDENCE } = typedModelIds
type Fact = import('../../src/services/providers/typedModelIds.ts').ModelListFact
const NOW = Date.parse('2026-09-20T12:00:00Z')
const fact = (partial: Partial<Fact> & Pick<Fact, 'family' | 'name' | 'typed' | 'list'>): Fact => partial

console.log('============================================================')
console.log(' the doctor\'s Model lists row over recorded lists')
console.log('============================================================')

section('§1 the one comparison: a typed id is served when the list carries it, whatever the case or spacing')
{
  const all = judgeTypedIds(['gpt-6-astra', 'GPT-5.6-Sol'], ['gpt-6-astra', ' gpt-5.6-sol '])
  check('every typed id served → not served is empty', all.notServed.length === 0 && all.served.length === 2, JSON.stringify(all))
  check('the rows keep the typed order and spelling', all.rows.map(r => r.id).join(',') === 'gpt-6-astra,GPT-5.6-Sol')
  const one = judgeTypedIds(['gpt-6-astra', 'gpt-5.4-mini'], ['gpt-6-astra', 'gpt-5.6-sol'])
  check('one retired id → named as not served, the rest served', one.notServed.join(',') === 'gpt-5.4-mini' && one.served.join(',') === 'gpt-6-astra')
  const current = (id: string): string => (id === 'deepseek-chat' ? 'deepseek-v4-pro' : id)
  const aliased = judgeTypedIds(['deepseek-v4-pro'], ['deepseek-chat'], current)
  check("a family's current-id normaliser reads a retired alias as its current id", aliased.notServed.length === 0, JSON.stringify(aliased))
  const empty = judgeTypedIds(['a', 'b'], [])
  check('an empty list serves nothing', empty.notServed.join(',') === 'a,b')
  check('no typed ids → no rows', judgeTypedIds([], ['x']).rows.length === 0)
}

section('§2 the row over recorded lists')
const openaiList = (ids: string[], ageMs = 120_000): Fact =>
  fact({ family: 'openai', name: 'OpenAI', source: 'ChatGPT pro subscription', typed: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'], list: { kind: 'list', ids, fetchedAtMs: NOW - ageMs } })
const zai = fact({ family: 'zai', name: 'Z.AI', source: 'Z.AI API key (env)', typed: ['glm-5.3', 'glm-5.2'], list: { kind: 'no-endpoint', datedAt: '2026-08-21' } })
const moonshot = fact({ family: 'moonshot', name: 'Moonshot', typed: ['kimi-k3', 'kimi-k2.6'], list: { kind: 'no-credential' } })
const anthropic = fact({ family: 'anthropic', name: 'Anthropic', source: 'Anthropic API key', typed: ['claude-fable-5-1', 'claude-opus-5'], list: { kind: 'not-read' } })
const geminiUnread = fact({ family: 'gemini', name: 'Gemini', source: 'Gemini API key (GEMINI_API_KEY env)', typed: ['gemini-3.7-flash'], list: { kind: 'unread' } })
const deepseekNone = fact({ family: 'deepseek', name: 'DeepSeek', typed: ['deepseek-v4-pro', 'deepseek-flash'], list: { kind: 'no-credential' } })
const hfNone = fact({ family: 'huggingface', name: 'Hugging Face', typed: ['moonshotai/Kimi-K3'], list: { kind: 'no-credential' } })
{
  const row = composeModelListsRow([anthropic, openaiList(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini']), zai, moonshot, deepseekNone, geminiUnread, hfNone], NOW)
  check('every typed id served → ok', row.status === 'ok', row.status)
  check('the evidence counts served, not served and the lists read of the readable families', row.evidence === 'served 3 · not served 0 · lists read 1 of 5', row.evidence)
  check('the OpenAI line: source · served · not served · the list\'s age', row.detail.includes('OpenAI · ChatGPT pro subscription · served 3 · not served 0 · list from 2m ago'), row.detail)
  check('no not-served line beneath a family whose list serves every id', !row.detail.includes('not served:'))
  check('no fix on an ok row', row.fix === undefined)
}
{
  const row = composeModelListsRow([anthropic, openaiList(['gpt-6-astra', 'gpt-5.6-sol']), zai, moonshot, deepseekNone, geminiUnread, hfNone], NOW)
  check('one retired id → warn', row.status === 'warn', row.status)
  check('the evidence names the count and the family', row.evidence === 'served 2 · not served 1 (OpenAI) · lists read 1 of 5', row.evidence)
  const lines = row.detail.split('\n')
  const at = lines.indexOf('OpenAI · ChatGPT pro subscription · served 2 · not served 1 · list from 2m ago')
  check('the family line carries its counts', at >= 0, row.detail)
  check('the retired id is named on the line beneath the family', at >= 0 && lines[at + 1] === 'OpenAI not served: gpt-5.4-mini', lines[at + 1] ?? '')
  check('the warn row carries the fix', row.fix === MODEL_LISTS_FIX)
}
{
  const gemini = fact({ ...geminiUnread, list: { kind: 'list', ids: ['gemini-x'], fetchedAtMs: NOW - 5_000 } })
  const row = composeModelListsRow([anthropic, openaiList(['gpt-5.6-sol']), zai, moonshot, deepseekNone, gemini, hfNone], NOW)
  check('two families lacking → both named, counts summed', row.evidence === 'served 1 · not served 3 (OpenAI, Gemini) · lists read 2 of 5', row.evidence)
}
{
  const row = composeModelListsRow([anthropic, fact({ ...openaiList([]), list: { kind: 'unread' } }), zai, moonshot, deepseekNone, geminiUnread, hfNone], NOW)
  check('no list read for any signed-in family → info, never a caution', row.status === 'info', row.status)
  check('the evidence says no list was read in this process, how one is read, and who reads every list', row.evidence === 'no list read in this process — /model or a chat naming the family reads it; the release-day check reads every list · lists read 0 of 5' && row.evidence.startsWith(MODEL_LISTS_UNREAD_EVIDENCE), row.evidence)
  check('the OpenAI line reads no list read in this process with the typed count', row.detail.includes('OpenAI · ChatGPT pro subscription · no list read in this process — /model or a chat naming the family reads it · 3 typed ids not judged'), row.detail)
  check('no fix on an info row', row.fix === undefined)
}
{
  const failed = fact({ ...openaiList([]), list: { kind: 'unread', lastError: 'http-503', lastAttemptAtMs: NOW - 30_000 } })
  const row = composeModelListsRow([anthropic, failed, zai, moonshot, deepseekNone, geminiUnread, hfNone], NOW)
  check('a failed read with nothing cached → info, the line names the failure and its age', row.status === 'info' && row.detail.includes('OpenAI · ChatGPT pro subscription · the last list read failed 30s ago (http-503) · 3 typed ids not judged'), row.detail)
}
{
  const row = composeModelListsRow([fact({ ...anthropic, source: undefined }), fact({ ...openaiList([]), list: { kind: 'no-credential' } }), fact({ ...zai, source: undefined }), moonshot, deepseekNone, fact({ ...geminiUnread, source: undefined, list: { kind: 'no-credential' } }), hfNone], NOW)
  check('no credential for any family with a live list → info', row.status === 'info', row.status)
  check('the evidence says so', row.evidence === 'no credential for a family with a live list · lists read 0 of 5', row.evidence)
  check('a family without a credential reads not judged', row.detail.includes('OpenAI · no credential · 3 typed ids not judged'), row.detail)
}
{
  const lines = modelListFamilyLines(zai, NOW)
  check('a family with no live endpoint reads the dated typed table', lines[0] === 'Z.AI · Z.AI API key (env) · no live list — typed table dated 2026-08-21 · 2 typed ids', lines[0])
  check('the same words without a credential', modelListFamilyLines(fact({ ...zai, source: undefined }), NOW)[0] === 'Z.AI · no credential · no live list — typed table dated 2026-08-21 · 2 typed ids')
  check('Moonshot without a credential reads not judged, its list being readable', modelListFamilyLines(moonshot, NOW)[0] === 'Moonshot · no credential · 2 typed ids not judged', modelListFamilyLines(moonshot, NOW)[0])
  check('Anthropic reads no list read, naming who does read it', modelListFamilyLines(anthropic, NOW)[0] === 'Anthropic · no list read (Mercury reads no Anthropic list; the release-day check does) · 2 typed ids', modelListFamilyLines(anthropic, NOW)[0])
  const skew = modelListFamilyLines(openaiList(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'], -60_000), NOW)
  check('a list stamped in the future reads clock skew, never a negative age', skew[0]?.endsWith('list from clock skew') === true, skew[0])
  const broken = fact({ ...openaiList([]), list: { kind: 'unreadable', reason: 'boom' } })
  const row = composeModelListsRow([broken], NOW)
  check('a cache that could not be read → unknown with the reason (the one unknown)', row.status === 'unknown' && row.detail === 'OpenAI · ChatGPT pro subscription · the cached list could not be read (boom) · 3 typed ids not judged', row.detail)
}

section('§2b Moonshot over its cached live list: served, lacking, unread, unreadable')
{
  const moonshotList = (ids: string[]): Fact => fact({ family: 'moonshot', name: 'Moonshot', source: 'MOONSHOT_API_KEY (env)', typed: ['kimi-k3', 'kimi-k2.6'], list: { kind: 'list', ids, fetchedAtMs: NOW - 30_000 } })
  const world = (ms: Fact): Fact[] => [anthropic, fact({ ...openaiList([]), list: { kind: 'no-credential' } }), zai, ms, deepseekNone, geminiUnread, hfNone]
  const served = composeModelListsRow(world(moonshotList(['kimi-k3', 'kimi-k2.6', 'kimi-fixture-next'])), NOW)
  check('a Moonshot list serving every typed id → ok, counted among the five readable lists', served.status === 'ok' && served.evidence === 'served 2 · not served 0 · lists read 1 of 5', served.evidence)
  check('the Moonshot line: source · served · not served · the list\'s age', served.detail.includes('Moonshot · MOONSHOT_API_KEY (env) · served 2 · not served 0 · list from 30s ago'), served.detail)
  const lacking = composeModelListsRow(world(moonshotList(['kimi-k3'])), NOW)
  const lines = lacking.detail.split('\n')
  const at = lines.indexOf('Moonshot · MOONSHOT_API_KEY (env) · served 1 · not served 1 · list from 30s ago')
  check('a Moonshot list lacking a typed id → warn naming Moonshot, the id on the line beneath', lacking.status === 'warn' && lacking.evidence === 'served 1 · not served 1 (Moonshot) · lists read 1 of 5' && at >= 0 && lines[at + 1] === 'Moonshot not served: kimi-k2.6' && lacking.fix === MODEL_LISTS_FIX, lacking.detail)
  const unread = composeModelListsRow(world(fact({ ...moonshotList([]), list: { kind: 'unread' } })), NOW)
  check('a Moonshot credential with no list read → info, the same read hint as every other family', unread.status === 'info' && unread.detail.includes('Moonshot · MOONSHOT_API_KEY (env) · no list read in this process — /model or a chat naming the family reads it · 2 typed ids not judged'), unread.detail)
  const failed = composeModelListsRow(world(fact({ ...moonshotList([]), list: { kind: 'unread', lastError: 'the models endpoint answered a body that is not JSON', lastAttemptAtMs: NOW - 10_000 } })), NOW)
  check('a failed Moonshot read with nothing cached → info naming the failure and its age', failed.status === 'info' && failed.detail.includes('Moonshot · MOONSHOT_API_KEY (env) · the last list read failed 10s ago (the models endpoint answered a body that is not JSON) · 2 typed ids not judged'), failed.detail)
  const broken = composeModelListsRow(world(fact({ ...moonshotList([]), list: { kind: 'unreadable', reason: 'boom' } })), NOW)
  check('a Moonshot cache that could not be read → unknown with the reason', broken.status === 'unknown' && broken.evidence === 'a cached list could not be read · lists read 0 of 5' && broken.detail.includes('Moonshot · MOONSHOT_API_KEY (env) · the cached list could not be read (boom) · 2 typed ids not judged'), broken.detail)
}

section('§3 the reader: the facts come from the catalogue caches this process holds, never a fetch')
const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.ts')
const { GEMINI_PRICE_PINS } = await import('../../src/services/providers/gemini/geminiPins.ts')
const { DEEPSEEK_DISPLAY_PINS } = await import('../../src/services/providers/deepseek/deepseekPins.ts')
const { HUGGINGFACE_DISPLAY_PINS } = await import('../../src/services/providers/huggingface/huggingfacePins.ts')
const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const openaiCatalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const moonshotCatalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const deepseekCatalogue = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')
const geminiCatalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const huggingfaceCatalogue = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')
const GPT_TYPED = GPT_DISPLAY_PINS.map(p => p.id)
check('the GPT typed table holds at least three ids (two are withheld below)', GPT_TYPED.length >= 3, String(GPT_TYPED.length))
const OWNER_LIST = GPT_TYPED.slice(0, -2)
const byFamily = (facts: Fact[], family: Fact['family']): Fact => facts.find(f => f.family === family)!
{
  const facts = readModelListFacts(process.env)
  check('seven families in the brief\'s order', facts.map(f => f.family).join(',') === 'anthropic,openai,zai,moonshot,deepseek,gemini,huggingface', facts.map(f => f.family).join(','))
  check('the typed ids are the tables\' own', byFamily(facts, 'openai').typed.join(',') === GPT_DISPLAY_PINS.map(p => p.id).join(',') && byFamily(facts, 'gemini').typed.join(',') === GEMINI_PRICE_PINS.map(p => p.id).join(',') && byFamily(facts, 'deepseek').typed.join(',') === DEEPSEEK_DISPLAY_PINS.map(p => p.id).join(',') && byFamily(facts, 'huggingface').typed.join(',') === HUGGINGFACE_DISPLAY_PINS.map(p => p.id).join(',') && byFamily(facts, 'moonshot').typed.join(',') === KIMI_DISPLAY_PINS.map(p => p.id).join(','))
  check('Z.AI reads its dated typed table (no documented model list); Moonshot reads through its cache, never the dated table', byFamily(facts, 'zai').list.kind === 'no-endpoint' && byFamily(facts, 'zai').typed.length > 0 && byFamily(facts, 'moonshot').list.kind !== 'no-endpoint' && byFamily(facts, 'moonshot').typed.length > 0, JSON.stringify(byFamily(facts, 'moonshot')))
  check('Anthropic reads not-read with the fixture key as its source', byFamily(facts, 'anthropic').list.kind === 'not-read' && byFamily(facts, 'anthropic').source === 'Anthropic API key', JSON.stringify(byFamily(facts, 'anthropic')))
  check('the five keyed families read no credential in a home with none', (['openai', 'deepseek', 'gemini', 'huggingface', 'moonshot'] as const).every(f => byFamily(facts, f).list.kind === 'no-credential'))
  const row = composeModelListsRow(facts, Date.now())
  check('the row over that home reads info', row.status === 'info', row.evidence)
}
{
  writeFileSync(join(HOME, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { idToken: 'fixture-id-token', accessToken: 'fixture-chatgpt-access-token-0001', refreshToken: 'fixture-refresh-token-0001', accountId: 'acct_fixture', planType: 'pro', email: 'sam@example.test', accessTokenExpiresAtMs: Date.now() + 24 * 3600_000 } }))
  openaiCatalogue.__resetOpenaiCatalogueForTest()
  const before = byFamily(readModelListFacts(process.env), 'openai')
  check('a signed-in ChatGPT source with nothing cached reads unread with its label', before.list.kind === 'unread' && before.source === 'ChatGPT pro subscription', JSON.stringify(before))
  check('the row over that home reads info with the approved evidence', composeModelListsRow(readModelListFacts(process.env), Date.now()).status === 'info')
  const primed = openaiCatalogue.primeOpenaiCatalogue({ sourceKind: 'chatgpt-subscription', models: OWNER_LIST.map(id => ({ id, supportedReasoningEfforts: ['low', 'high'], reasoningEffortsStated: true })), fetchedAtMs: Date.now() - 90_000 })
  check('the cache primed (the same road the daemon\'s hand-off takes)', primed)
  const facts = readModelListFacts(process.env)
  const openai = byFamily(facts, 'openai')
  check('the reader returns the cached list with its stamp', openai.list.kind === 'list' && openai.list.ids.join(',') === OWNER_LIST.join(','))
  const row = composeModelListsRow(facts, Date.now())
  const retired = GPT_TYPED.slice(-2)
  check(`the row warns naming the typed ids the list lacks (${retired.join(', ')})`, row.status === 'warn' && row.detail.includes(`OpenAI not served: ${retired.join(' · ')}`), row.detail)
  check('the evidence counts them', row.evidence.startsWith(`served ${OWNER_LIST.length} · not served ${retired.length} (OpenAI)`), row.evidence)
  openaiCatalogue.__resetOpenaiCatalogueForTest()
}
{
  const listOf = (ids: string[], extra: Record<string, unknown> = {}): typeof fetch =>
    (async () => new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'fixture', ...extra })) }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-key-0001'
  deepseekCatalogue.__resetDeepseekCatalogueForTest()
  await deepseekCatalogue.refreshDeepseekCatalogue({ env: process.env, fetchImpl: listOf(['deepseek-v4-pro']) })
  const ds = byFamily(readModelListFacts(process.env), 'deepseek')
  check('DeepSeek: the cached list is read through the env key\'s account', ds.list.kind === 'list' && ds.list.ids.join(',') === 'deepseek-v4-pro' && ds.source === 'DEEPSEEK_API_KEY (env)', JSON.stringify(ds))
  check('DeepSeek carries its current-id normaliser (a retired alias in a list reads as its current id)', ds.current !== undefined && ds.current('DeepSeek-V4-Pro') === 'deepseek-v4-pro')
  delete process.env.DEEPSEEK_API_KEY
  deepseekCatalogue.__resetDeepseekCatalogueForTest()

  process.env.GEMINI_API_KEY = 'fixture-gemini-key-0001'
  geminiCatalogue.__resetGeminiCatalogueForTest()
  const geminiFetch = (async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  await geminiCatalogue.refreshGeminiCatalogue('api-key', { env: process.env, fetchImpl: geminiFetch })
  const gm = byFamily(readModelListFacts(process.env), 'gemini')
  check('Gemini: the cached list is read for the key source', gm.list.kind === 'list' && gm.list.ids.join(',') === 'gemini-3.7-flash', JSON.stringify(gm))
  geminiCatalogue.__resetGeminiCatalogueForTest()
  const failing = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
  await geminiCatalogue.refreshGeminiCatalogue('api-key', { env: process.env, fetchImpl: failing })
  const failed = byFamily(readModelListFacts(process.env), 'gemini')
  check('Gemini: a failed read with nothing cached reads unread with the error', failed.list.kind === 'unread' && typeof failed.list.lastError === 'string', JSON.stringify(failed))
  delete process.env.GEMINI_API_KEY
  geminiCatalogue.__resetGeminiCatalogueForTest()

  process.env.HF_TOKEN = 'fixture-hf-token-0001'
  huggingfaceCatalogue.__resetHuggingfaceCatalogueForTest()
  await huggingfaceCatalogue.refreshHuggingfaceCatalogue({ env: process.env, fetchImpl: listOf(['moonshotai/Kimi-K3'], { providers: [{ provider: 'fixture', status: 'live' }] }) })
  const hf = byFamily(readModelListFacts(process.env), 'huggingface')
  check('Hugging Face: the cached list is read for the token', hf.list.kind === 'list' && hf.list.ids.join(',') === 'moonshotai/Kimi-K3', JSON.stringify(hf))
  delete process.env.HF_TOKEN

  const KIMI_TYPED = KIMI_DISPLAY_PINS.map(p => p.id)
  check('the Kimi typed table holds at least two ids (one is withheld below)', KIMI_TYPED.length >= 2, String(KIMI_TYPED.length))
  process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key-0001'
  moonshotCatalogue.__resetMoonshotCatalogueForTest()
  const unreadMoonshot = byFamily(readModelListFacts(process.env), 'moonshot')
  check('Moonshot: a key with nothing cached reads unread with its label, and the row stays info', unreadMoonshot.list.kind === 'unread' && unreadMoonshot.source === 'MOONSHOT_API_KEY (env)' && composeModelListsRow(readModelListFacts(process.env), Date.now()).status === 'info', JSON.stringify(unreadMoonshot))
  await moonshotCatalogue.refreshMoonshotCatalogue({ env: process.env, fetchImpl: listOf([...KIMI_TYPED, 'kimi-fixture-next'], { created: 1 }) })
  const ms = byFamily(readModelListFacts(process.env), 'moonshot')
  check("Moonshot: the cached list is read through the env key's account, the list's own ids and stamp", ms.list.kind === 'list' && ms.list.ids.join(',') === [...KIMI_TYPED, 'kimi-fixture-next'].join(',') && ms.list.fetchedAtMs > 0 && ms.source === 'MOONSHOT_API_KEY (env)', JSON.stringify(ms))
  const servedRow = composeModelListsRow(readModelListFacts(process.env), Date.now())
  check('the row over that list reads ok and counts the Moonshot list among the readable five', servedRow.status === 'ok' && servedRow.evidence === `served ${KIMI_TYPED.length} · not served 0 · lists read 1 of 5`, servedRow.evidence)
  moonshotCatalogue.__resetMoonshotCatalogueForTest()
  await moonshotCatalogue.refreshMoonshotCatalogue({ env: process.env, fetchImpl: listOf(KIMI_TYPED.slice(0, -1), { created: 1 }) })
  const lackingRow = composeModelListsRow(readModelListFacts(process.env), Date.now())
  check(`the row warns naming Moonshot and the typed id its list lacks (${KIMI_TYPED.at(-1)})`, lackingRow.status === 'warn' && lackingRow.evidence.startsWith(`served ${KIMI_TYPED.length - 1} · not served 1 (Moonshot)`) && lackingRow.detail.includes(`Moonshot not served: ${KIMI_TYPED.at(-1)}`), `${lackingRow.evidence}\n${lackingRow.detail}`)
  moonshotCatalogue.__resetMoonshotCatalogueForTest()
  await moonshotCatalogue.refreshMoonshotCatalogue({ env: process.env, fetchImpl: (async () => new Response('<html>not a list</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch })
  const failedMoonshot = byFamily(readModelListFacts(process.env), 'moonshot')
  check("Moonshot: a failed read with nothing cached reads unread with the reader's own words", failedMoonshot.list.kind === 'unread' && failedMoonshot.list.lastError === 'the models endpoint answered a body that is not JSON', JSON.stringify(failedMoonshot))
  delete process.env.MOONSHOT_API_KEY
  moonshotCatalogue.__resetMoonshotCatalogueForTest()
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
