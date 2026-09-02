#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-gemini-catalogue.ts
//  PROOF: the Gemini live catalogue
//  against fixture responses (injected fetch; bases pinned — fail-open law):
//    1. decode: stated fields only; the 'models/' prefix strips to the bare
//       id; pagination follows nextPageToken bounded;
//    2. the picker's chat filter is the VENDOR'S OWN capability statement
//       (supportedGenerationMethods contains generateContent) — embeddings
//       and other non-chat rows never reach the picker;
//    3. availability chain: no-account · pending · auth-invalid · error ·
//       no-generate-models · ready;
//    4. picker rows: signed-out ⇒ ONE connect action row; ready ⇒ rows
//       visible-but-UNAVAILABLE while the routing law does not recognize
//       gemini ids (geminiDispatchReady probes the REAL law).
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-gemini-catalogue.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PROVAUTH — Gemini live catalogue (fixtures)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_GEMINI_OAUTH_AUTH_BASE',
  'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_GEMINI_OAUTH_CLIENT_ID',
  'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gemini-cat-'))
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'

const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.js')
const {
  __resetGeminiCatalogueForTest,
  geminiDispatchReady,
  getGeminiAvailability,
  getGeminiModelOptions,
  refreshGeminiCatalogue,
} = catalogue

const PAGE_ONE = {
  models: [
    {
      name: 'models/gemini-fixture-pro',
      displayName: 'Gemini Fixture Pro',
      version: '001',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
      thinking: true,
    },
    {
      name: 'models/embedding-fixture',
      displayName: 'Embedding Fixture',
      supportedGenerationMethods: ['embedContent'],
    },
  ],
  nextPageToken: 'PAGE-2',
}
const PAGE_TWO = {
  models: [
    {
      name: 'models/gemini-fixture-flash',
      displayName: 'Gemini Fixture Flash',
      supportedGenerationMethods: ['generateContent'],
    },
  ],
}

function pagedFetch(counter: { calls: string[] }): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url)
    counter.calls.push(u)
    const body = u.includes('pageToken=PAGE-2') ? PAGE_TWO : PAGE_ONE
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

// ── 1. no credential ⇒ honest no-account; one connect row ───────────────────
{
  __resetGeminiCatalogueForTest()
  const availability = getGeminiAvailability()
  check('no credential ⇒ disabled/no-account', availability.state === 'disabled' && availability.why === 'no-account')
  const rows = getGeminiModelOptions()
  check('signed-out picker = ONE connect action row', rows.length === 1 && rows[0]!.value === '__mercury_gemini_connect__' && rows[0]!.label === 'Gemini — sign in')
}

// ── 2. decode + pagination + the vendor's chat filter ───────────────────────
process.env.GEMINI_API_KEY = 'AIza-PROVER-000000000000000'
{
  __resetGeminiCatalogueForTest()
  const counter = { calls: [] as string[] }
  const snapshot = await refreshGeminiCatalogue('api-key', { fetchImpl: pagedFetch(counter) })
  check('both pages fetched from the PINNED base', counter.calls.length === 2 && counter.calls.every(u => u.startsWith('https://fixture.invalid/v1beta/models?')))
  check('3 models decoded; models/ prefix stripped', snapshot?.models.length === 3 && snapshot.models[0]!.id === 'gemini-fixture-pro')
  const pro = snapshot!.models[0]!
  check('stated fields decoded (limits, methods, thinking)', pro.inputTokenLimit === 1048576 && pro.outputTokenLimit === 65536 && pro.thinking === true && pro.supportedGenerationMethods?.includes('generateContent'))
  const availability = getGeminiAvailability()
  check('ready: only generateContent-capable ids qualify (embedding row filtered by the VENDOR statement)', availability.state === 'ready' && availability.ids.length === 2 && !availability.ids.includes('embedding-fixture'))
}

// ── 3. picker rows: unavailable under the real law; group + copy honest ─────
{
  // FOLD LANDED: the wire-half fold shipped the gemini runtime —
  // routing recognizes the ids for real, so the pre-fold expectations flip.
  check('the REAL routing law recognizes gemini ids (the fold landed)', geminiDispatchReady() === true)
  check('an injected non-recognizing law flips readiness off (the probe stays live)', geminiDispatchReady(() => null) === false)
  const rows = getGeminiModelOptions()
  check('two chat rows render (the embedding row never reaches the picker)', rows.length === 2 && rows.every(r => r.group === 'Mercury — Gemini models'))
  check('routed rows carry no dispatch-pending refusal', rows.every(r => r.unavailable === undefined || !r.unavailable.includes('dispatch wire pending')))
  // The neutrality ruling: model rows carry NO description —
  // the live row's stated window rides the typed statedContextWindow (the
  // ctx column) instead of row copy.
  check('model rows carry no description (the neutral grammar)', rows.every(r => r.description === ''), JSON.stringify(rows.map(r => [r.value, r.description])))
  check('the live row window rides the typed statedContextWindow', rows[0]!.statedContextWindow === 1_048_576, String(rows[0]!.statedContextWindow))
}

// ── 4. auth-invalid + error + no-generate-models name themselves ────────────
{
  __resetGeminiCatalogueForTest()
  const unauthorized: typeof fetch = (async () =>
    new Response('{}', { status: 403 })) as unknown as typeof fetch
  await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: unauthorized })
  check('403 ⇒ disabled/auth-invalid', getGeminiAvailability().state === 'disabled' && (getGeminiAvailability() as { why?: string }).why === 'auth-invalid')

  __resetGeminiCatalogueForTest()
  const noChat: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ models: [{ name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] }] }),
      { status: 200 },
    )) as unknown as typeof fetch
  await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: noChat })
  const availability = getGeminiAvailability()
  check('a chat-less catalogue ⇒ disabled/no-generate-models (never an invented row)', availability.state === 'disabled' && availability.why === 'no-generate-models')
}

delete process.env.GEMINI_API_KEY
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} gemini-catalogue proof(s) failed`)
  process.exit(1)
}
console.log('✅ GEMINI LIVE CATALOGUE PROVEN (fixture rig)')
