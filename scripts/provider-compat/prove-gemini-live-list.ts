import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import fixture from './fixtures/gemini-public-sources-2026-10-01.json'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_DISABLE_LIVE_CATALOGUES', 'MERCURY_DISABLE_1M_CONTEXT']) delete process.env[name]
const hits: Array<{ path: string; headers: Headers; body: any }> = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  const body = request.method === 'POST' ? await request.json() as any : {}
  hits.push({ path, headers: request.headers, body })
  if (path === '/v1beta/models') return Response.json(fixture.fixtureOnly)
  if (path === '/v1beta/models/gemini-fixture-next:streamGenerateContent') return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: request.headers.get('x-goog-api-key') ? 'fixture key answer' : 'fixture OAuth answer', thoughtSignature: 'fixture-signed-text', futureField: true }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, thoughtsTokenCount: 3 }, futureField: true })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  return Response.json({ error: { message: 'unexpected fixture road' } }, { status: 404 })
} })
const base = `http://127.0.0.1:${server.port}/v1beta`
process.env.MERCURY_GEMINI_API_BASE = base
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'http://127.0.0.1:1/token'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const accounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { geminiPricePin } = await import('../../src/services/providers/gemini/geminiPins.ts')
const { getModelMaxOutputTokens, resolveContextWindow, effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
let failures = 0
let checks = 0
function check(label: string, yes: boolean) { checks++; if (!yes) failures++; console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}`) }
const model = 'gemini-fixture-next'
try {
  const suppliedEnv = { MERCURY_GEMINI_API_BASE: base, GEMINI_API_KEY: 'fixture-explicit-env-key' }
  await catalogue.refreshGeminiCatalogue('api-key', { env: suppliedEnv, force: true })
  check('an explicit credential environment owns both catalogue and picker cache identity', catalogue.getGeminiModelOptions(suppliedEnv).some(row => row.value === model && !row.unavailable) && catalogue.geminiContextWindowFor(model, suppliedEnv)?.window === 1234567)
  for (const source of ['api-key', 'oauth'] as const) {
    writeFileSync(join(proofHome, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: source, client: { clientId: 'fixture-own-client' }, tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }), { mode: 0o600 })
    process.env.GEMINI_API_KEY = 'fixture-key'
    catalogue.__resetGeminiCatalogueForTest()
    hits.length = 0
    const snapshot = await catalogue.refreshGeminiCatalogue(source, { force: true })
    check(`${source}: the live list is fetched from the Gemini API using only its selected credential`, snapshot?.models.length === 8 && hits.length === 1 && hits[0]?.path === '/v1beta/models' && (source === 'oauth' ? hits[0]?.headers.get('authorization') === 'Bearer fixture-access' && hits[0]?.headers.get('x-goog-api-key') === null : hits[0]?.headers.get('x-goog-api-key') === 'fixture-key' && hits[0]?.headers.get('authorization') === null))
    const options = catalogue.getGeminiModelOptions()
    check(`${source}: an unknown live-listed id is offered, selectable and routable with no price pin`, options.some(row => row.value === model && row.statedContextWindow === 1234567 && !row.unavailable) && declaredRouteOf(model) === 'gemini' && geminiPricePin(model) === undefined)
    check(`${source}: agent products and embeddings are not chat picker rows or live dispatch IDs`, options.length === 2 && !options.some(row => /antigravity|deep-research|embedding/.test(row.value)) && !catalogue.cachedLiveIds().has('antigravity-preview-latest') && !catalogue.cachedLiveIds().has('deep-research-pro-preview'))
    check(`${source}: image and speech generators answer generateContent but are not chat models — never a picker row, never a live dispatch id, never the gemini class head`, !options.some(row => /image|banana|tts/i.test(row.value) || /nano banana|tts/i.test(String(row.label))) && !catalogue.cachedLiveIds().has('gemini-2.5-flash-image') && !catalogue.cachedLiveIds().has('nano-banana-pro-preview') && !catalogue.cachedLiveIds().has('gemini-2.5-flash-preview-tts') && catalogue.geminiMakesNoChat({ id: 'gemini-3-pro-image-preview' }) && catalogue.geminiMakesNoChat({ id: 'gemini-nano-banana-2.1' }) && catalogue.geminiMakesNoChat({ id: 'x-preview', displayName: 'Nano Banana 2 Lite' }) && !catalogue.geminiMakesNoChat({ id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview' }) && !catalogue.geminiMakesNoChat({ id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }))
    const context = resolveContextWindow(model)
    const output = getModelMaxOutputTokens(model)
    const effort = effortVocabularyFor(model)
    check(`${source}: the public capability owner reads window, output ceiling and effort from the new row`, context.effectiveWindow === 1234567 && context.source === 'live-current' && output.upperLimit === 43210 && output.default <= 43210 && effort.kind === 'provider' && effort.vocabulary.join(',') === 'low,medium,high')
    const fallback = resolveContextWindow('gemini-fixture-defaults')
    check(`${source}: missing metadata keeps labelled conservative defaults and sends no invented effort`, fallback.source === 'fallback' && fallback.effectiveWindow > 0 && Boolean(fallback.fallbackReason) && catalogue.geminiOutputTokenLimitFor('gemini-fixture-defaults') === undefined && catalogue.geminiEffortVocabularyFor('gemini-fixture-defaults').length === 0)
    const replies: any[] = []
    for await (const item of geminiCallModel({ messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } }] as never, systemPrompt: asSystemPrompt(['Answer briefly.']), thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal, options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never })) if (item.type === 'assistant') replies.push(item)
    check(`${source}: that exact unknown id dispatches on the native road under its own credential header and answers`, replies.some(reply => reply.message.content.some((part: any) => part.text === (source === 'oauth' ? 'fixture OAuth answer' : 'fixture key answer'))) && hits.at(-1)?.path === `/v1beta/models/${model}:streamGenerateContent` && (source === 'oauth' ? hits.at(-1)?.headers.get('authorization')?.startsWith('Bearer ') === true && hits.at(-1)?.headers.get('x-goog-api-key') === null : hits.at(-1)?.headers.get('x-goog-api-key') === 'fixture-key' && hits.at(-1)?.headers.get('authorization') === null))
    check(`${source}: the selected output ceiling and stated thinking capability reach the wire`, hits.at(-1)?.body.generationConfig?.maxOutputTokens === 64 && hits.at(-1)?.body.generationConfig?.thinkingConfig?.thinkingLevel === 'LOW')
    check(`${source}: new native id preserves opaque thought signatures and usage despite additive fields`, replies.at(-1)?.geminiProviderTurn?.parts?.[0]?.thoughtSignature === 'fixture-signed-text' && replies.at(-1)?.message.usage?.output_tokens === 5)
  }
  accounts.writeGeminiOauthClientConfig(null)
  check('the public client is not installed as a default; own-client mechanics are unchanged', accounts.geminiOauthClientConfig() === undefined && accounts.geminiOauthClientMissingCopy()?.includes('Desktop app') === true)
} finally { server.stop(true); rmSync(proofHome, { recursive: true, force: true }) }
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
