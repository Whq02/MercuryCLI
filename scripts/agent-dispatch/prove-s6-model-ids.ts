#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-s6-model-ids.ts
//  PROOF.
//  Entirely fixture-driven — no network, no billables: the openai catalogue
//  cache is SEEDED through refreshOpenaiCatalogue with a fixture fetch, the
//  fixture bases point at an unroutable loopback port (any accidental real
//  fetch fails fast), and the TTL anchor keeps seeded snapshots authoritative
//  for the whole run:
//
//    1. SCHEMA surface (engines default-on): class aliases + the advertised
//       ids (GPT display pins + glm); never a deprecated id.
//    2. EXACT gpt ids validate against the LIVE catalogue: every offered id
//       resolves with the live displayName (no generation gate — the era
//       ≥5.6 floor died); hidden ids refuse (hidden-or-retired);
//       unknown ids refuse listing what IS qualified.
//    3. Deprecated gpt ids refuse naming the deprecation — never dispatched.
//    4. Live catalogue unreachable ⇒ display-pin fallback: pinned ids resolve
//       (labeled static-pin validated); unknown ids refuse.
//    5. EXACT glm ids: the catalogue pin resolves; unverified glm ids refuse;
//       an uncredentialed openai dispatch refuses naming 'no-account:openai'.
//    6. The class aliases: 'gpt' ⇒ the highest-priority QUALIFIED live
//       candidate (never an invented id); 'glm' ⇒ the catalogue pin;
//       Anthropic ids stay null.
//
//  Run:  ~/.bun/bin/bun run scripts/agent-dispatch/prove-s6-model-ids.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

console.log('============================================================')
console.log(' S6 — exact engine model ids proof (native lane)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'ZAI_API_KEY',
  'OPENAI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
]) {
  savedEnv[key] = process.env[key]
}
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-s6-home-'))
}
// Belt-and-braces: any accidental REAL fetch dies fast on an unroutable base.
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

const { engineDispatchModelsForSchema, resolveEngineDispatch } = await import(
  '../../src/utils/swarm/engineDispatch.js'
)
const { DEPRECATED_GPT_IDS } = await import('../../src/utils/router/providers/openai.js')
const { __resetProviderDiscoveryForTest, refreshProviderDiscovery } = await import(
  '../../src/utils/router/providerDiscovery.js'
)
const { __resetOpenaiCatalogueForTest, refreshOpenaiCatalogue, GPT_DISPLAY_PINS } = await import(
  '../../src/services/providers/openai/openaiCatalogue.js'
)

// The live-catalogue wire fixture (subscription-backend record shape).
const LIVE_WIRE = {
  data: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_reasoning_level: 'medium',
      // LIVE semantics: ASCENDING rank — 1 is the top model.
      priority: 1,
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6 Terra',
      supported_reasoning_levels: ['low', 'medium', 'high'],
      priority: 2,
    },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: ['high', 'xhigh'] },
    { slug: 'gpt-5.7-preview', supported_reasoning_levels: [], visibility: 'hidden' },
  ],
}

function fixtureFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}
function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error('fixture: catalogue unreachable')
  }) as unknown as typeof fetch
}

/** Credential both providers + seed the openai live catalogue from the wire
 *  fixture (TTL-anchored NOW, so dispatch-time refreshes serve the seed —
 *  never the network). */
async function armWithLiveCatalogue(): Promise<void> {
  process.env.ZAI_API_KEY = 'zai-proof-fake-key'
  process.env.OPENAI_API_KEY = 'sk-proof-fake-key'
  __resetProviderDiscoveryForTest()
  __resetOpenaiCatalogueForTest()
  await refreshProviderDiscovery('openai', { force: true })
  const snap = await refreshOpenaiCatalogue('api-key', {
    force: true,
    fetchImpl: fixtureFetch(LIVE_WIRE),
  })
  if (!snap || snap.models.length === 0) {
    throw new Error('fixture seeding failed — the proof harness is broken')
  }
}

/** Credentials with an UNREACHABLE catalogue (failure snapshot seeded,
 *  TTL-anchored — the fallback path). */
async function armWithUnreachableCatalogue(): Promise<void> {
  process.env.ZAI_API_KEY = 'zai-proof-fake-key'
  process.env.OPENAI_API_KEY = 'sk-proof-fake-key'
  __resetProviderDiscoveryForTest()
  __resetOpenaiCatalogueForTest()
  await refreshProviderDiscovery('openai', { force: true })
  await refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: failingFetch() })
}

//
section('1 · schema surface — always advertises the engine grammar')
//
{
  const advertised = engineDispatchModelsForSchema()
  check('class aliases first', advertised[0] === 'gpt' && advertised[1] === 'glm', advertised.join(','))
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'glm-5.2']) {
    check(`advertises '${id}'`, advertised.includes(id))
  }
  check('never a deprecated id', DEPRECATED_GPT_IDS.every(id => !advertised.includes(id)))
}

//
section('2 · exact gpt ids vs the LIVE catalogue (qualification law)')
//
{
  await armWithLiveCatalogue()
  const sol = await resolveEngineDispatch('gpt-5.6-sol')
  check(
    "'gpt-5.6-sol' resolves live: backend openai, exact model, live displayName",
    sol?.backend === 'openai' && sol.model === 'gpt-5.6-sol' && sol.displayLabel === 'GPT-5.6 Sol',
    JSON.stringify(sol),
  )
  const hidden = await refusal(() => resolveEngineDispatch('gpt-5.7-preview'))
  check(
    'a hidden live id refuses (hidden-or-retired), listing the qualified set',
    hidden.includes('hidden-or-retired') && hidden.includes('gpt-5.6-sol'),
    hidden,
  )
  const unknown = await refusal(() => resolveEngineDispatch('gpt-9000'))
  check(
    "an unknown id refuses via the live list ('gpt-9000' not offered)",
    unknown.includes("'gpt-9000'") && unknown.includes('not-in-live-catalogue'),
    unknown,
  )
  // The live list offers gpt-5.5, so it RESOLVES — qualification is the
  // account catalogue's answer, not an era generation verdict (the ≥5.6
  // floor refusal died with the provider-parity direction).
  const prevGen = await resolveEngineDispatch('gpt-5.5')
  check(
    "'gpt-5.5' resolves live (offered by the account — no generation gate)",
    prevGen?.backend === 'openai' && prevGen.model === 'gpt-5.5' && prevGen.displayLabel === 'GPT-5.5',
    JSON.stringify(prevGen),
  )
}

//
section('3 · deprecated ids refuse loudly (live list irrelevant)')
//
{
  for (const dead of DEPRECATED_GPT_IDS) {
    const message = await refusal(() => resolveEngineDispatch(dead))
    check(
      `'${dead}' refuses naming the deprecation`,
      message.includes('DEPRECATED') && message.includes(dead),
      message,
    )
  }
}

//
section('4 · live catalogue unreachable ⇒ display-pin fallback')
//
{
  await armWithUnreachableCatalogue()
  const pinned = await resolveEngineDispatch('gpt-5.6-terra')
  check(
    "'gpt-5.6-terra' resolves via the official pins, labeled as such",
    pinned?.backend === 'openai' &&
      pinned.model === 'gpt-5.6-terra' &&
      pinned.displayLabel.includes('static-pin validated'),
    JSON.stringify(pinned),
  )
  const unknown = await refusal(() => resolveEngineDispatch('gpt-9000'))
  check(
    'unknown id refuses via the pins when live is unreachable',
    unknown.includes('catalogue-verified') && unknown.includes(GPT_DISPLAY_PINS[0]!.id),
    unknown,
  )
}

//
section('5 · exact glm ids + gate refusals')
//
{
  await armWithLiveCatalogue()
  const glm = await resolveEngineDispatch('glm-5.2')
  check(
    "'glm-5.2' resolves: backend zai, exact model",
    glm?.backend === 'zai' && glm.model === 'glm-5.2',
    JSON.stringify(glm),
  )
  const unverified = await refusal(() => resolveEngineDispatch('glm-4.6'))
  check(
    "'glm-4.6' refuses (not catalogue-verified)",
    unverified.includes('catalogue-verified') && unverified.includes('glm-5.2'),
    unverified,
  )
  // Uncredentialed openai dispatch: the provider-availability refusal names
  // the stable credential code (the gate refusal retired with the gate).
  delete process.env.OPENAI_API_KEY
  __resetProviderDiscoveryForTest()
  const uncredentialed = await refusal(() => resolveEngineDispatch('gpt-5.6-sol'))
  check(
    "uncredentialed exact id refuses naming 'no-account:openai'",
    uncredentialed.includes('no-account:openai'),
    uncredentialed,
  )
}

//
section('6 · the class aliases law')
//
{
  await armWithLiveCatalogue()
  const gpt = await resolveEngineDispatch('gpt')
  check(
    "'gpt' ⇒ the highest-priority QUALIFIED live candidate (gpt-5.6-sol)",
    gpt?.backend === 'openai' && gpt.model === 'gpt-5.6-sol' && gpt.displayLabel === 'GPT-5.6 Sol',
    JSON.stringify(gpt),
  )
  const glm = await resolveEngineDispatch('glm')
  check(
    "'glm' ⇒ the zai catalogue FLAGSHIP pin (glm-5.3)",
    glm?.backend === 'zai' && glm.model === 'glm-5.3',
  )
  const plain = await resolveEngineDispatch('opus')
  check("'opus' ⇒ null (the Anthropic grammar untouched)", plain === null)
  const none = await resolveEngineDispatch(undefined)
  check('undefined ⇒ null', none === null)
}

// Restore the ambient env exactly.
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
__resetProviderDiscoveryForTest()
__resetOpenaiCatalogueForTest()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S6 MODEL-ID PROOFS PASS')
else console.log(`${failures} S6 MODEL-ID PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
