#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version }

const env = process.env
const LIST_TIMEOUT_MS = 15_000
const STALE_MARGIN_MS = 6 * 60_000
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'

const PROBE_BY_COMPLETION = process.argv.includes('--probe-by-completion')

type ProbeVerdict = { id: string; served: true } | { id: string; served: false; reason: string } | { id: string; unreachable: string }
type ListResult = { ids: string[] } | { unreachable: string } | { typedTable: string; ids: string[] } | { probed: ProbeVerdict[] }
type FamilyCheck = { family: string; source: string; typed: string[]; list: () => Promise<ListResult>; current?: (id: string) => string }

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getApiFetch, getProxyFetchOptions } = await import('../../src/utils/proxy.js')
const { fetchWithProviderDeadline } = await import('../../src/services/providers/fetchDeadline.js')
const { catalogueTrafficVerdict } = await import('../../src/services/providers/catalogueGate.js')
const { getEssentialTrafficOnlyReason } = await import('../../src/utils/privacyLevel.js')
const GATED_FAMILIES = new Set(['openai', 'gemini', 'deepseek', 'openrouter', 'huggingface'])
const { getAuthHeaders, getUserAgent } = await import('../../src/utils/http.js')
const { judgeTypedIds } = await import('../../src/services/providers/typedModelIds.js')

async function getJson(provider: string, url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const response = await fetchWithProviderDeadline(getApiFetch(), provider, LIST_TIMEOUT_MS, url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': getUserAgent(), ...headers },
    ...(getProxyFetchOptions() as Record<string, unknown>),
  } as RequestInit)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

function staleToken(expiresAtMs: number | null | undefined, words: string): string | undefined {
  if (typeof expiresAtMs !== 'number') return undefined
  return expiresAtMs - Date.now() < STALE_MARGIN_MS ? words : undefined
}

async function moonshotList(baseUrl: string, key: string): Promise<ListResult> {
  const { fetchMoonshotLiveModels } = await import('../../src/services/providers/moonshot/moonshotCatalogue.js')
  const result = await fetchMoonshotLiveModels({ baseUrl, key })
  return { ids: result.models.map(model => model.id) }
}

async function probeByCompletion(ids: readonly string[], probe: (id: string) => Promise<ProbeVerdict>): Promise<ListResult> {
  const probed: ProbeVerdict[] = []
  for (const id of ids) probed.push(await probe(id))
  return { probed }
}

async function zaiCompletionVerdict(opts: { apiKey: string; requestUrl: string; id: string }): Promise<ProbeVerdict> {
  const { streamZaiChat } = await import('../../src/services/providers/zai/zaiClient.js')
  const events = streamZaiChat({ apiKey: opts.apiKey, baseUrl: opts.requestUrl, request: { model: opts.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 } })
  for await (const event of events) {
    if (event.type !== 'stream-fault') return { id: opts.id, served: true }
    const fault = event.fault
    if (fault.kind === 'api-error' && fault.code === 'zai-1211') return { id: opts.id, served: false, reason: `${fault.code}: ${fault.message}` }
    if (fault.kind === 'api-error' || fault.kind === 'http-error') return { id: opts.id, unreachable: `${fault.code}: ${fault.message}` }
    if (fault.kind === 'transport-error' && fault.code === 'fetch-failed') return { id: opts.id, unreachable: fault.message }
    if ((fault.kind === 'timeout' && fault.code === 'first-byte-timeout') || fault.kind === 'cancelled') return { id: opts.id, unreachable: fault.message }
    return { id: opts.id, served: true }
  }
  return { id: opts.id, unreachable: 'the completion ended without an answer' }
}

const families: FamilyCheck[] = []
const skipped: string[] = []

{
  const openai = await import('../../src/services/providers/openai/openaiAccounts.js')
  const { fetchOpenaiLiveModels } = await import('../../src/services/providers/openai/openaiClient.js')
  const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
  const typed = GPT_DISPLAY_PINS.map(pin => pin.id)
  const presence = openai.openaiSubscriptionPresence()
  if (presence.state !== 'absent') {
    families.push({
      family: 'openai',
      source: presence.planType ? `ChatGPT ${presence.planType} subscription` : 'ChatGPT subscription',
      typed,
      list: async () => {
        if (presence.state === 'expired') return { unreachable: 'the ChatGPT sign-in has expired — /logins openai signs in again' }
        const tokens = await openai.currentSubscriptionTokens({ now: () => 0 })
        if (!tokens?.accessToken) return { unreachable: 'the ChatGPT sign-in holds no access token' }
        const stale = staleToken(tokens.accessTokenExpiresAtMs, 'the stored ChatGPT access token has expired or is about to — open Mercury (or /logins openai) so it is refreshed, then run this check again')
        if (stale) return { unreachable: stale }
        const auth = await openai.resolveOpenaiRequestAuth({ sourceKind: 'chatgpt-subscription' })
        if (!auth) return { unreachable: 'the ChatGPT sign-in produced no request credentials' }
        const result = await fetchOpenaiLiveModels({ baseUrl: auth.baseUrl, headers: auth.headers })
        return { ids: result.models.map(model => model.id) }
      },
    })
  }
  const key = openai.resolveOpenaiApiKey(env)
  if (key) {
    families.push({
      family: 'openai',
      source: `OpenAI API key (${key.source})`,
      typed,
      list: async () => {
        const auth = await openai.resolveOpenaiRequestAuth({ sourceKind: 'api-key' })
        if (!auth) return { unreachable: 'the OpenAI API key produced no request credentials' }
        const result = await fetchOpenaiLiveModels({ baseUrl: auth.baseUrl, headers: auth.headers })
        return { ids: result.models.map(model => model.id) }
      },
    })
  }
  if (presence.state === 'absent' && !key) skipped.push(`openai · no credential · ${typed.length} typed ids not judged`)
}

{
  const auth = await import('../../src/utils/auth.js')
  const model = await import('../../src/utils/model/model.js')
  const typed = [...new Set([model.getDefaultFableModel(), model.getDefaultOpusModel(), model.getDefaultSonnetModel(), model.getDefaultHaikuModel(), model.getSmallFastModel()].map(id => model.normalizeModelStringForAPI(id)))]
  const headers = getAuthHeaders()
  if (headers.error) skipped.push(`anthropic · no credential · ${typed.length} typed ids not judged`)
  else {
    const subscriber = auth.isClaudeAISubscriber()
    families.push({
      family: 'anthropic',
      source: subscriber ? 'claude.ai sign-in' : 'Anthropic API key',
      typed,
      list: async () => {
        if (subscriber) {
          const stale = staleToken(auth.getClaudeAIOAuthTokens()?.expiresAt, 'the stored claude.ai access token has expired or is about to — open Mercury so it is refreshed, then run this check again')
          if (stale) return { unreachable: stale }
        }
        const base = (env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '')
        const ids: string[] = []
        let after: string | undefined
        for (let page = 0; page < 5; page++) {
          const url = `${base}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
          const { status, body } = await getJson('anthropic', url, { ...headers.headers, 'anthropic-version': ANTHROPIC_VERSION })
          if (status < 200 || status >= 300) return { unreachable: `the models endpoint answered HTTP ${status}` }
          const page_ = body as { data?: Array<{ id?: unknown }>; has_more?: boolean; last_id?: string } | undefined
          if (!Array.isArray(page_?.data)) return { unreachable: 'the models endpoint answered no data array' }
          for (const row of page_.data) if (typeof row?.id === 'string') ids.push(row.id)
          if (page_.has_more !== true || typeof page_.last_id !== 'string') break
          after = page_.last_id
        }
        return { ids }
      },
    })
  }
}

{
  const gemini = await import('../../src/services/providers/gemini/geminiAccounts.js')
  const { fetchGeminiLiveModels } = await import('../../src/services/providers/gemini/geminiCatalogue.js')
  const { GEMINI_PRICE_PINS } = await import('../../src/services/providers/gemini/geminiPins.js')
  const typed = GEMINI_PRICE_PINS.map(pin => pin.id)
  const key = gemini.resolveGeminiApiKey(env)
  if (key) {
    families.push({
      family: 'gemini',
      source: `Gemini API key (${key.source})`,
      typed,
      list: async () => {
        const auth = await gemini.resolveGeminiRequestAuth({ sourceKind: 'api-key' })
        if (!auth) return { unreachable: 'the Gemini API key produced no request credentials' }
        const result = await fetchGeminiLiveModels({ baseUrl: auth.baseUrl, headers: auth.headers })
        return { ids: result.models.map(model => model.id) }
      },
    })
  }
  if (gemini.geminiOauthConnected()) {
    families.push({
      family: 'gemini',
      source: 'Google account',
      typed,
      list: async () => {
        const tokens = await gemini.currentGeminiTokens({ now: () => 0 })
        if (!tokens?.accessToken) return { unreachable: 'the Google sign-in holds no access token' }
        const stale = staleToken(tokens.accessTokenExpiresAtMs, 'the stored Google access token has expired or is about to — open Mercury so it is refreshed, then run this check again')
        if (stale) return { unreachable: stale }
        const auth = await gemini.resolveGeminiRequestAuth({ sourceKind: 'oauth' })
        if (!auth) return { unreachable: 'the Google sign-in produced no request credentials' }
        const result = await fetchGeminiLiveModels({ baseUrl: auth.baseUrl, headers: auth.headers })
        return { ids: result.models.map(model => model.id) }
      },
    })
  }
  if (!key && !gemini.geminiOauthConnected()) skipped.push(`gemini · no credential · ${typed.length} typed ids not judged`)
}

{
  const accounts = await import('../../src/services/providers/deepseek/deepseekAccounts.js')
  const { fetchDeepseekLiveModels } = await import('../../src/services/providers/deepseek/deepseekCatalogue.js')
  const { DEEPSEEK_DISPLAY_PINS, deepseekCurrentModelId } = await import('../../src/services/providers/deepseek/deepseekPins.js')
  const typed = DEEPSEEK_DISPLAY_PINS.map(pin => pin.id)
  const key = accounts.resolveDeepseekApiKey(env)
  if (key) {
    families.push({
      family: 'deepseek',
      source: `DeepSeek API key (${key.source})`,
      typed,
      current: id => deepseekCurrentModelId(id.trim().toLowerCase()),
      list: async () => {
        const result = await fetchDeepseekLiveModels({ baseUrl: accounts.deepseekApiBase(env), key: key.key })
        return { ids: result.models.map(model => model.id) }
      },
    })
  } else skipped.push(`deepseek · no credential · ${typed.length} typed ids not judged`)
}

{
  const accounts = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
  const { fetchOpenrouterLiveModels } = await import('../../src/services/providers/openrouter/openrouterCatalogue.js')
  const auth = accounts.resolveOpenrouterRequestAuth(env)
  if (auth) {
    families.push({
      family: 'openrouter',
      source: auth.account.label,
      typed: [],
      list: async () => {
        const result = await fetchOpenrouterLiveModels({ baseUrl: auth.baseUrl, headers: auth.headers })
        return { ids: result.models.map(model => model.id) }
      },
    })
  } else skipped.push('openrouter · no credential · no typed ids')
}

{
  const accounts = await import('../../src/services/providers/huggingface/huggingfaceAccounts.js')
  const { fetchHuggingfaceLiveModels } = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.js')
  const { HUGGINGFACE_DISPLAY_PINS } = await import('../../src/services/providers/huggingface/huggingfacePins.js')
  const typed = HUGGINGFACE_DISPLAY_PINS.map(pin => pin.id)
  const key = accounts.resolveHuggingfaceApiKey(env)
  if (key) {
    families.push({
      family: 'huggingface',
      source: accounts.resolveHuggingfaceAccount(env)?.label ?? `Hugging Face token (${key.source})`,
      typed,
      list: async () => {
        if (key.source === 'oauth') {
          const stale = staleToken(accounts.huggingfaceStoredTokens()?.accessTokenExpiresAtMs, 'the stored Hugging Face access token has expired or is about to — open Mercury so it is refreshed, then run this check again')
          if (stale) return { unreachable: stale }
        }
        const result = await fetchHuggingfaceLiveModels({ url: accounts.huggingfaceModelsUrl(env), headers: { authorization: `Bearer ${key.key}` } })
        return { ids: result.models.map(model => model.id) }
      },
    })
  } else skipped.push(`huggingface · no credential · ${typed.length} typed ids not judged`)
}

{
  const { resolveZaiDispatch } = await import('../../src/utils/router/providerDiscovery.js')
  const { zaiChatCompletionsUrl } = await import('../../src/services/providers/zai/zaiClient.js')
  const { keyLanePins } = await import('../../src/utils/model/modelOptions.js')
  const { GLM_PRICE_PINS } = await import('../../src/services/providers/zai/glmPins.js')
  const typed = keyLanePins('zai').map(pin => pin.id)
  const table: ListResult = { typedTable: GLM_PRICE_PINS.map(pin => pin.observedAt).sort().at(-1) ?? 'unknown', ids: GLM_PRICE_PINS.map(pin => pin.id) }
  const dispatch = resolveZaiDispatch(env)
  const trafficOff = getEssentialTrafficOnlyReason(env)
  if (dispatch && PROBE_BY_COMPLETION && trafficOff) console.log(`--probe-by-completion sends nothing: ${trafficOff} is set; the Z.AI ids read the dated table`)
  if (dispatch) {
    families.push({
      family: 'zai',
      source: dispatch.plan === 'coding' ? `GLM Coding Plan key (${dispatch.source})` : `Z.AI API key (${dispatch.source})`,
      typed,
      list: PROBE_BY_COMPLETION && !trafficOff
        ? () => probeByCompletion(typed, id => zaiCompletionVerdict({ apiKey: dispatch.key, requestUrl: zaiChatCompletionsUrl(env, dispatch.plan), id }))
        : () => Promise.resolve(table),
    })
  } else skipped.push(`zai · no credential · ${typed.length} typed ids not judged`)
}

{
  const accounts = await import('../../src/services/providers/moonshot/moonshotAccounts.js')
  const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.js')
  const typed = KIMI_DISPLAY_PINS.map(pin => pin.id)
  const key = accounts.resolveMoonshotApiKey(env)
  if (key) {
    families.push({
      family: 'moonshot',
      source: key.source === 'env' ? 'MOONSHOT_API_KEY (env)' : 'Moonshot API key (stored)',
      typed,
      list: () => moonshotList(accounts.moonshotApiBase(env), key.key),
    })
  }
  const kimi = accounts.moonshotStoredTokens()
  if (kimi) {
    families.push({
      family: 'moonshot',
      source: 'Kimi account (device-code sign-in)',
      typed,
      list: () => {
        const stale = staleToken((kimi as { accessTokenExpiresAtMs?: number }).accessTokenExpiresAtMs, 'the stored Kimi access token has expired or is about to — open Mercury so it is refreshed, then run this check again')
        if (stale) return Promise.resolve({ unreachable: stale })
        return moonshotList(accounts.kimiCodingBase(accounts.moonshotLoginRegion(), env), kimi.accessToken)
      },
    })
  }
  if (!key && !kimi) skipped.push(`moonshot · no credential · ${typed.length} typed ids not judged`)
}

let notServed = 0
let judged = 0
let fetchable = 0
for (const check of families) {
  const gate = GATED_FAMILIES.has(check.family) ? catalogueTrafficVerdict(check.family as never, env) : { allowed: true, reason: '' }
  const verdict: ListResult = gate.allowed
    ? await check.list().catch((error: unknown) => ({ unreachable: error instanceof Error ? error.message : String(error) }))
    : { unreachable: gate.reason }
  if ('typedTable' in verdict) {
    for (const row of judgeTypedIds(check.typed, verdict.ids, check.current).rows) {
      if (!row.served) notServed++
      console.log(`${check.family} · ${check.source} · ${row.id} · ${row.served ? 'served' : 'not served'} (typed table dated ${verdict.typedTable}, no live list)`)
    }
    continue
  }
  fetchable++
  if ('probed' in verdict) {
    if (verdict.probed.every(row => !('unreachable' in row))) judged++
    for (const row of verdict.probed) {
      if ('unreachable' in row) console.log(`${check.family} · ${check.source} · ${row.id} · unreachable (${row.unreachable})`)
      else if (row.served) console.log(`${check.family} · ${check.source} · ${row.id} · served`)
      else {
        notServed++
        console.log(`${check.family} · ${check.source} · ${row.id} · not served (${row.reason})`)
      }
    }
    continue
  }
  if ('unreachable' in verdict) {
    if (check.typed.length === 0) console.log(`${check.family} · ${check.source} · (no typed ids) · unreachable (${verdict.unreachable})`)
    for (const id of check.typed) console.log(`${check.family} · ${check.source} · ${id} · unreachable (${verdict.unreachable})`)
    continue
  }
  judged++
  const judgement = judgeTypedIds(check.typed, verdict.ids, check.current)
  if (check.typed.length === 0) console.log(`${check.family} · ${check.source} · (no typed ids) · ${verdict.ids.length} served`)
  for (const row of judgement.rows) {
    if (!row.served) notServed++
    console.log(`${check.family} · ${check.source} · ${row.id} · ${row.served ? 'served' : 'not served'}`)
  }
}
for (const line of skipped) console.log(line)
const pagesBase = (() => {
  const at = process.argv.indexOf('--signin-pages-base')
  return at >= 0 ? process.argv[at + 1]?.replace(/\/+$/, '') : undefined
})()
const { geminiGuidePages } = await import('../../src/components/geminiConnectGuide.js')
const pages = geminiGuidePages()
let deadPages = 0
for (const page of pages) {
  const parsed = new URL(page.address)
  const target = pagesBase ? `${pagesBase}${parsed.pathname}${parsed.search}` : page.address
  let verdict: string
  try {
    const response = await fetchWithProviderDeadline(getApiFetch(), 'gemini', LIST_TIMEOUT_MS, target, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'user-agent': getUserAgent() },
      ...(getProxyFetchOptions() as Record<string, unknown>),
    } as RequestInit)
    if (response.status >= 400) deadPages++
    verdict = response.status >= 400 ? `dead (HTTP ${response.status})` : `answers HTTP ${response.status}`
  } catch (error) {
    deadPages++
    verdict = `dead (${error instanceof Error ? error.message : String(error)})`
  }
  console.log(`sign-in page · ${page.address} · observed ${page.observedAt} · ${verdict}`)
}
console.log(
  deadPages === 0
    ? `sign-in pages: every one of ${pages.length} answered (an unsigned HEAD on a Console path answers a redirect to Google's sign-in, so a page that moved behind that wall still reads alive here; only a dead host or a 404 reads dead)`
    : `sign-in pages: ${deadPages} of ${pages.length} dead (a dead host or a 404; a page that moved behind Google's sign-in wall reads alive here)`,
)
console.log(
  notServed === 0
    ? `typed model ids: every typed id a fetched list or a dated table could judge is served (${judged} of ${fetchable} lists fetched)`
    : `typed model ids: ${notServed} typed id(s) not served by a fetched list or a dated table (${judged} of ${fetchable} lists fetched)`,
)
process.exit(notServed === 0 && deadPages === 0 ? 0 : 1)
