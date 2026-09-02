#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-context-window-families.ts — the context
//  WINDOW across every family, and the truth flow when a source lands.
//
//  The operator's rail read "ctx 28% · 200k" on a 1M OpenRouter model: the
//  owner (resolveContextWindow) budgeted the persisted id at the first-party
//  default because nothing had fetched the catalogue, and nothing re-derived
//  the window when it did. This prover pins the family law and the flow:
//
//   W1  ONE law per family: live source first, dated pin second, LABELLED
//       conservative default last. Unfetched: every pin-less carrier /
//       engine id is 200,000 with source 'fallback' AND a reason; pinned
//       engine ids ride their pin; first-party 1M ids ride theirs.
//   W2  live sources decide: OpenRouter context_length (a 1M row budgets
//       1,048,576; a 131,072 row budgets 131,072 — never 200k), Gemini
//       inputTokenLimit (1,048,576 — the arm this lane added), Hugging Face
//       provider context_length, the GPT catalogue's served window, the
//       local server's stated window.
//   W3  the 1M kill-switch clamps EVERY family identically to 200,000 with
//       the same reason, and leaves a sub-200k stated window alone.
//   W4  each source landing bumps the context-window EPOCH the surfaces
//       subscribe to (OpenRouter · Gemini · Hugging Face · OpenAI · local).
//   W5  awaitContextWindowSource lands the model's source before the
//       compaction decision (instant once cached; the owner flips from
//       fallback to live-current across the await); warmContextWindowSources
//       fetches every connected family's catalogue at boot.
//   W6  the edges are wired: REPL boot warms; the OpenRouter dispatch edge
//       refreshes (TTL'd); shouldAutoCompact awaits the source.
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-context-window-families.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
for (const key of [
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN',
  'ANTHROPIC_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'CLAUDE_EFFORT', 'MERCURY_LOCAL_PROBE_TARGETS',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-ctx-families-'))
// Ambient-state law: until the loopback fixture below is armed, any
// accidental real fetch dies on an unroutable port.
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/api/v1'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:9/v1beta'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'http://127.0.0.1:9/v1'
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { resolveContextWindow, MODEL_CONTEXT_WINDOW_DEFAULT } = await import('../../src/utils/model/capabilities.ts')
const epoch = await import('../../src/services/providers/catalogueEpoch.ts')
const warmup = await import('../../src/utils/model/contextWindowWarmup.ts')
const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const huggingface = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')
const openai = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const local = await import('../../src/services/providers/local/localDiscovery.ts')

const jsonFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

const OPENROUTER_ROWS = {
  data: [
    { id: 'stealth/ox-alpha', name: 'Ox Alpha', context_length: 1_048_576 },
    { id: 'meta/llama-small', name: 'Llama small', context_length: 131_072 },
    { id: 'vendor/unstated', name: 'No window stated' },
  ],
  total_count: 3,
  links: { next: null },
}
const GEMINI_ROWS = {
  models: [
    { name: 'models/gemini-fixture-pro', displayName: 'Gemini Fixture Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-fixture-mini', displayName: 'Gemini Fixture Mini', inputTokenLimit: 32_768, outputTokenLimit: 8_192, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-fixture-unstated', displayName: 'Unstated', supportedGenerationMethods: ['generateContent'] },
  ],
}
const HF_FIXTURE = JSON.parse(readFileSync(join(ROOT, 'scripts', 'provider-compat', 'fixtures', 'huggingface-models-2026-08-22.json'), 'utf8')) as unknown
const GPT_ROWS = {
  models: [
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 5, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 272_000, max_context_window: 272_000 },
  ],
}

console.log('============================================================')
console.log(' context window: one law per family, and the flow when a source lands')
console.log('============================================================')

section('W1 · unfetched: pins ride, everything else is the LABELLED conservative default')
{
  const fallbackIds = ['openrouter/stealth/ox-alpha', 'gemini-fixture-pro', 'huggingface/qwen/unpinned-model', 'local/llama3.1', 'compat/my-model', 'kimi-k2.5', 'glm-4.7', 'deepseek-v4-flash-vision-exp', 'gpt-5.4']
  for (const id of fallbackIds) {
    const r = resolveContextWindow(id)
    check(`${id}: 200,000 · source fallback · reason stated`, r.effectiveWindow === MODEL_CONTEXT_WINDOW_DEFAULT && r.source === 'fallback' && typeof r.fallbackReason === 'string' && r.fallbackReason.length > 0, JSON.stringify({ w: r.effectiveWindow, s: r.source, reason: r.fallbackReason }))
  }
  check('the OpenRouter fallback names the unfetched catalogue', /OpenRouter catalogue states no context length/.test(resolveContextWindow('openrouter/stealth/ox-alpha').fallbackReason ?? ''))
  check('the Gemini fallback names the unfetched catalogue', /Gemini catalogue states no context length/.test(resolveContextWindow('gemini-fixture-pro').fallbackReason ?? ''))
  const pins: Array<[string, number]> = [['kimi-k3', 1_048_576], ['deepseek-v4-pro', 1_000_000], ['glm-5.3', 1_000_000], ['claude-opus-5', 1_000_000], ['huggingface/deepseek-ai/DeepSeek-V4-Pro-0813', 1_048_576]]
  for (const [id, window] of pins) {
    const r = resolveContextWindow(id)
    check(`${id}: dated pin ${window.toLocaleString()} · source static-pin`, r.effectiveWindow === window && r.source === 'static-pin', JSON.stringify({ w: r.effectiveWindow, s: r.source }))
  }
  // A carrier-shaped id whose slug CONTAINS a first-party family word must
  // never borrow the first-party 1M pin by substring — its window is its own
  // source's row (the class found while pinning this law: every shape below
  // resolved 1,000,000 static-pin before the guard).
  for (const id of ['openrouter/anthropic/claude-opus-5', 'openrouter/anthropic/claude-sonnet-5', 'anthropic/claude-opus-5', 'huggingface/org/claude-opus-5-clone', 'local/opus-5-quant', 'compat/sonnet-5-proxy']) {
    const r = resolveContextWindow(id)
    check(`${id}: never the first-party 1M pin — fallback 200,000 until its own source states a window`, r.source === 'fallback' && r.effectiveWindow === 200_000, JSON.stringify({ w: r.effectiveWindow, s: r.source }))
  }
}

section('W2 · live sources decide (fixture catalogues through the REAL refreshes)')
{
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture'
  const e0 = epoch.catalogueEpoch()
  const orSnap = await openrouter.refreshOpenrouterCatalogue('env', { force: true, fetchImpl: jsonFetch(OPENROUTER_ROWS) })
  check('OpenRouter fixture landed (3 rows)', orSnap?.models.length === 3)
  const ox = resolveContextWindow('openrouter/stealth/ox-alpha')
  check('openrouter/stealth/ox-alpha: 1,048,576 · live-current', ox.effectiveWindow === 1_048_576 && ox.source === 'live-current', JSON.stringify({ w: ox.effectiveWindow, s: ox.source }))
  const llama = resolveContextWindow('openrouter/meta/llama-small')
  check('openrouter/meta/llama-small: 131,072 · live-current (a 128k-class model never budgets 200k)', llama.effectiveWindow === 131_072 && llama.source === 'live-current')
  const unstated = resolveContextWindow('openrouter/vendor/unstated')
  check('a listed row with NO stated window ⇒ labelled fallback (never a borrowed number)', unstated.effectiveWindow === 200_000 && unstated.source === 'fallback')
  check('the landing bumped the epoch', epoch.catalogueEpoch() > e0)

  process.env.GEMINI_API_KEY = 'AIza-fixture-000000000000000'
  const e1 = epoch.catalogueEpoch()
  const gSnap = await gemini.refreshGeminiCatalogue('api-key', { force: true, fetchImpl: jsonFetch(GEMINI_ROWS) })
  check('Gemini fixture landed (3 rows)', gSnap?.models.length === 3)
  const gpro = resolveContextWindow('gemini-fixture-pro')
  check('gemini-fixture-pro: 1,048,576 · live-current (inputTokenLimit — the arm the owner lacked)', gpro.effectiveWindow === 1_048_576 && gpro.source === 'live-current', JSON.stringify({ w: gpro.effectiveWindow, s: gpro.source }))
  const gmini = resolveContextWindow('gemini-fixture-mini')
  check('gemini-fixture-mini: 32,768 · live-current (a small stated window is honoured, never 200k)', gmini.effectiveWindow === 32_768 && gmini.source === 'live-current')
  check('gemini-fixture-unstated ⇒ labelled fallback', resolveContextWindow('gemini-fixture-unstated').source === 'fallback')
  check('the Gemini accessor folds case', gemini.geminiContextWindowFor('Gemini-Fixture-Pro')?.window === 1_048_576)
  check('the landing bumped the epoch', epoch.catalogueEpoch() > e1)

  // The catalogue door opens on a credential (catalogueGate): the Hugging
  // Face fixture lands under a fixture token, as every other family here.
  process.env.HF_TOKEN = 'hf-fixture'
  const e2 = epoch.catalogueEpoch()
  const hfSnap = await huggingface.refreshHuggingfaceCatalogue({ force: true, fetchImpl: ((async (url: unknown) => String(url).endsWith('/models') ? new Response(JSON.stringify(HF_FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) as typeof fetch) })
  check('Hugging Face fixture landed', (hfSnap?.models.length ?? 0) > 0)
  const hf = resolveContextWindow('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813')
  check('huggingface/deepseek-ai/DeepSeek-V4-Pro-0813: 1,048,576 · live-current', hf.effectiveWindow === 1_048_576 && hf.source === 'live-current', JSON.stringify({ w: hf.effectiveWindow, s: hf.source }))
  check('the landing bumped the epoch', epoch.catalogueEpoch() > e2)

  process.env.OPENAI_API_KEY = 'sk-fixture'
  const e3 = epoch.catalogueEpoch()
  const gptSnap = await openai.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: jsonFetch(GPT_ROWS) })
  check('GPT fixture landed', gptSnap?.models.length === 1)
  const gpt = resolveContextWindow('gpt-5.4')
  check('gpt-5.4: 272,000 served · live-current', gpt.effectiveWindow === 272_000 && gpt.source === 'live-current', JSON.stringify({ w: gpt.effectiveWindow, s: gpt.source }))
  check('the landing bumped the epoch', epoch.catalogueEpoch() > e3)
}

section('W3 · the 1M kill-switch clamps every family identically; sub-200k windows untouched')
{
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  for (const id of ['openrouter/stealth/ox-alpha', 'gemini-fixture-pro', 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813', 'kimi-k3', 'deepseek-v4-pro', 'glm-5.3', 'claude-opus-5']) {
    const r = resolveContextWindow(id)
    check(`${id}: clamped to 200,000 · reason 'clamped by the 1M kill-switch'`, r.effectiveWindow === 200_000 && r.fallbackReason === 'clamped by the 1M kill-switch', JSON.stringify({ w: r.effectiveWindow, reason: r.fallbackReason }))
  }
  check('openrouter/meta/llama-small stays 131,072 under the kill-switch', resolveContextWindow('openrouter/meta/llama-small').effectiveWindow === 131_072)
  check('gemini-fixture-mini stays 32,768 under the kill-switch', resolveContextWindow('gemini-fixture-mini').effectiveWindow === 32_768)
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
  check('kill-switch off ⇒ the 1M rows budget 1M again', resolveContextWindow('openrouter/stealth/ox-alpha').effectiveWindow === 1_048_576)
}

section('W4 · local discovery bumps the epoch too (the served window is a source)')
{
  const e0 = epoch.catalogueEpoch()
  local.__resetLocalDiscoveryForTest()
  await local.refreshLocalDiscovery({ force: true })
  check('a discovery pass (even an empty one) bumps the epoch', epoch.catalogueEpoch() > e0)
}

section('W5 · awaitContextWindowSource lands the source before a decision; boot warms every family')
{
  // A loopback OpenRouter fixture the REAL fetch path reaches (no injected
  // fetch: this is the compaction trigger's own edge).
  let modelsHits = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/models')) {
      modelsHits++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(OPENROUTER_ROWS))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${port}/api/v1`
  openrouter.__resetOpenrouterCatalogueForTest()
  const before = resolveContextWindow('openrouter/stealth/ox-alpha')
  check('before the source lands: fallback 200,000', before.effectiveWindow === 200_000 && before.source === 'fallback')
  check('contextWindowSourceReady reports NOT ready', (await warmup.contextWindowSourceReady('openrouter/stealth/ox-alpha')) === false)
  const started = Date.now()
  await warmup.awaitContextWindowSource('openrouter/stealth/ox-alpha')
  const elapsed = Date.now() - started
  const after = resolveContextWindow('openrouter/stealth/ox-alpha')
  check('after the await: 1,048,576 · live-current (one /models GET)', after.effectiveWindow === 1_048_576 && after.source === 'live-current' && modelsHits === 1, JSON.stringify({ w: after.effectiveWindow, s: after.source, hits: modelsHits }))
  check('the await is bounded (well under the 3s cap on loopback)', elapsed < 3_000, `${elapsed}ms`)
  check('contextWindowSourceReady reports ready', (await warmup.contextWindowSourceReady('openrouter/stealth/ox-alpha')) === true)
  const again = Date.now()
  await warmup.awaitContextWindowSource('openrouter/stealth/ox-alpha')
  check('a second await is instant (cached; no second GET inside the TTL)', Date.now() - again < 50 && modelsHits === 1)
  check('a first-party id needs no source: instant, ready', (await warmup.contextWindowSourceReady('claude-opus-5')) === true)
  // Boot warm-up: every connected family's catalogue refreshes (TTL'd — the
  // OpenRouter snapshot just landed, so no extra GET); a family without a
  // credential costs nothing.
  delete process.env.GEMINI_API_KEY
  delete process.env.OPENAI_API_KEY
  await warmup.warmContextWindowSources()
  check('warmContextWindowSources resolves; the TTL keeps the OpenRouter GET count at 1', modelsHits === 1)
  openrouter.__resetOpenrouterCatalogueForTest()
  await warmup.warmContextWindowSources()
  check('with the catalogue reset, boot warm-up fetches it (GET count 2) and the owner reads 1,048,576', modelsHits === 2 && resolveContextWindow('openrouter/stealth/ox-alpha').effectiveWindow === 1_048_576)
  await new Promise<void>(resolve => server.close(() => resolve()))
}

section('W6 · the edges are wired (source pins)')
{
  const repl = src('src/screens/REPL.tsx')
  check('REPL boot warms every window source (deferred one macrotask past the mount)', /import\('\.\.\/utils\/model\/contextWindowWarmup\.js'\)[\s\S]{0,80}warmContextWindowSources\(\)/.test(repl))
  const orLane = src('src/services/providers/openrouter/openrouterCallModel.ts')
  check('the OpenRouter dispatch edge refreshes the catalogue (TTL\'d, fire-and-forget)', /refreshOpenrouterCatalogue\(account\.keySource\)\.catch/.test(orLane))
  const compact = src('src/services/compact/autoCompact.ts')
  check('shouldAutoCompact awaits the model\'s window source before reading the threshold', /await awaitContextWindowSource\(model\)\s*\n\s*const tokenCount = tokenCountWithEstimation/.test(compact))
  const owner = src('src/utils/model/capabilities.ts')
  check('the owner carries a Gemini arm reading geminiContextWindowFor', /geminiContextWindowFor\(normalizeForEnginePins\(model\)\)/.test(owner))
  for (const file of ['openrouter/openrouterCatalogue.ts', 'gemini/geminiCatalogue.ts', 'huggingface/huggingfaceCatalogue.ts', 'openai/openaiCatalogue.ts', 'local/localDiscovery.ts']) {
    check(`${file} notes the source change (epoch bump)`, /bumpCatalogueEpoch\(\)/.test(src(`src/services/providers/${file}`)))
  }
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`))
process.exit(failures === 0 ? 0 : 1)
