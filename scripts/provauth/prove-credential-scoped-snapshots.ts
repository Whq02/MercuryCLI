#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-credential-scoped-snapshots.ts — every per-provider
//  snapshot is keyed on the CREDENTIAL that fetched it, never on the source
//  kind alone.
//
//  The class (closed for the OpenRouter catalogue first, then found
//  again on every other lane): a catalogue keyed on 'api-key' / 'chatgpt-
//  subscription' / 'env', or a module-singleton key-usage/balance record
//  keyed on nothing, outlives the credential that fetched it — a relogin
//  under another key or account repaints the departed account's rows,
//  qualification, credits or balance until the TTL expires.
//
//  Laws, over the REAL modules (injected fetches; every base pinned to a
//  non-resolvable host; a scratch config home):
//   §1 OpenAI catalogue (api-key source): key A fetches; the same key rides
//      the TTL; key B sees NO snapshot and fetches fresh; A's snapshot
//      survives beside B's
//   §2 Gemini catalogue: the same law under GEMINI_API_KEY
//   §3 Hugging Face catalogue: a keyed view is per token (the anonymous
//      list still serves a keyless read)
//   §4 OpenRouter key usage: the observed credits belong to the key that
//      polled them — a relogin reads nothing observed until its own poll
//   §5 DeepSeek balance: the same law under DEEPSEEK_API_KEY
//   §6 Moonshot balance: the same law under MOONSHOT_API_KEY
//
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-credential-scoped-snapshots.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' PROVAUTH — snapshots are keyed on the credential that fetched them')
console.log('============================================================')

for (const key of [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_MOONSHOT_API_BASE',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-cred-snapshots-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'https://fixture.invalid/openai/v1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://fixture.invalid/openai-auth'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'https://fixture.invalid/hf/v1'
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'https://fixture.invalid/hub'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://fixture.invalid/deepseek'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://fixture.invalid/moonshot/v1'

const { credentialFingerprint } = await import('../../src/services/providers/credentialIdentity.ts')

function countingFetch(body: unknown, calls: { n: number; auth: string[] }): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.n++
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.auth.push(headers.authorization ?? headers.Authorization ?? headers['x-goog-api-key'] ?? '')
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

// ============================================================================
section('§0 the fingerprint is one-way, short, and absence-safe')
// ============================================================================
{
  const a = credentialFingerprint('sk-A')
  const b = credentialFingerprint('sk-B')
  check('12 hex chars, distinct per material, stable per material', /^[0-9a-f]{12}$/.test(a) && a !== b && a === credentialFingerprint('sk-A'))
  check("absent material reads 'none' (never a digest of the empty string)", credentialFingerprint(undefined) === 'none' && credentialFingerprint('') === 'none')
  check('the material itself never appears in the digest', !a.includes('sk-A'))
}

// ============================================================================
section('§1 OpenAI catalogue — per key, not per source kind')
// ============================================================================
{
  const openai = await import('../../src/services/providers/openai/openaiCatalogue.ts')
  openai.__resetOpenaiCatalogueForTest()
  const page = {
    data: [
      { id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high'] },
    ],
  }
  process.env.OPENAI_API_KEY = 'sk-openai-KEY-A-0000000000'
  const a = { n: 0, auth: [] as string[] }
  const first = await openai.refreshOpenaiCatalogue('api-key', { fetchImpl: countingFetch(page, a) })
  check('key A fetches its catalogue (one call, bearer A)', a.n === 1 && first?.models.length === 1 && a.auth[0] === 'Bearer sk-openai-KEY-A-0000000000')
  const again = { n: 0, auth: [] as string[] }
  await openai.refreshOpenaiCatalogue('api-key', { fetchImpl: countingFetch(page, again) })
  check('the same key rides the TTL (zero calls)', again.n === 0)
  process.env.OPENAI_API_KEY = 'sk-openai-KEY-B-0000000000'
  check('key B sees NO cached snapshot for the same source kind', openai.getCachedOpenaiCatalogue('api-key') === null)
  const b = { n: 0, auth: [] as string[] }
  const fresh = await openai.refreshOpenaiCatalogue('api-key', { fetchImpl: countingFetch(page, b) })
  check('key B fetches FRESH under its own bearer', b.n === 1 && b.auth[0] === 'Bearer sk-openai-KEY-B-0000000000' && fresh?.models.length === 1)
  process.env.OPENAI_API_KEY = 'sk-openai-KEY-A-0000000000'
  check("key A's snapshot survives beside B's (no refetch on return)", openai.getCachedOpenaiCatalogue('api-key') !== null)
  delete process.env.OPENAI_API_KEY
  check('no key ⇒ no snapshot claimed', openai.getCachedOpenaiCatalogue('api-key') === null)
}

// ============================================================================
section('§2 Gemini catalogue — per key')
// ============================================================================
{
  const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
  gemini.__resetGeminiCatalogueForTest()
  const page = { models: [{ name: 'models/gemini-fixture-pro', supportedGenerationMethods: ['generateContent'] }] }
  process.env.GEMINI_API_KEY = 'AIza-GEMINI-KEY-A-00000000'
  const a = { n: 0, auth: [] as string[] }
  await gemini.refreshGeminiCatalogue('api-key', { fetchImpl: countingFetch(page, a) })
  check('key A fetches (x-goog-api-key A)', a.n === 1 && a.auth[0] === 'AIza-GEMINI-KEY-A-00000000')
  const again = { n: 0, auth: [] as string[] }
  await gemini.refreshGeminiCatalogue('api-key', { fetchImpl: countingFetch(page, again) })
  check('the same key rides the TTL', again.n === 0)
  process.env.GEMINI_API_KEY = 'AIza-GEMINI-KEY-B-00000000'
  check('key B sees NO cached snapshot', gemini.getCachedGeminiCatalogue('api-key') === null)
  const b = { n: 0, auth: [] as string[] }
  await gemini.refreshGeminiCatalogue('api-key', { fetchImpl: countingFetch(page, b) })
  check('key B fetches fresh under its own key', b.n === 1 && b.auth[0] === 'AIza-GEMINI-KEY-B-00000000')
  check('the availability chain reads the CURRENT key\'s snapshot', gemini.getGeminiAvailability().state === 'ready')
  delete process.env.GEMINI_API_KEY
}

// ============================================================================
section('§3 Hugging Face catalogue — a keyed view is per token')
// ============================================================================
{
  const hf = await import('../../src/services/providers/huggingface/huggingfaceCatalogue.ts')
  hf.__resetHuggingfaceCatalogueForTest()
  const page = { object: 'list', data: [{ id: 'openai/gpt-oss-120b', providers: [{ provider: 'groq', status: 'live', context_length: 131072 }] }] }
  process.env.HF_TOKEN = 'hf_TOKEN_A_000000000000'
  const a = { n: 0, auth: [] as string[] }
  const first = await hf.refreshHuggingfaceCatalogue({ fetchImpl: countingFetch(page, a) })
  check("token A fetches; the snapshot key names the source AND the token's digest", a.n === 1 && first?.key === `env:${credentialFingerprint('hf_TOKEN_A_000000000000')}` && a.auth[0] === 'Bearer hf_TOKEN_A_000000000000')
  const again = { n: 0, auth: [] as string[] }
  await hf.refreshHuggingfaceCatalogue({ fetchImpl: countingFetch(page, again) })
  check('the same token rides the TTL', again.n === 0)
  process.env.HF_TOKEN = 'hf_TOKEN_B_000000000000'
  const b = { n: 0, auth: [] as string[] }
  const fresh = await hf.refreshHuggingfaceCatalogue({ fetchImpl: countingFetch(page, b) })
  check('token B fetches fresh under its own bearer', b.n === 1 && b.auth[0] === 'Bearer hf_TOKEN_B_000000000000' && fresh?.key === `env:${credentialFingerprint('hf_TOKEN_B_000000000000')}`)
  delete process.env.HF_TOKEN
  check('a keyless read falls to the anonymous list (none fetched here ⇒ null), never a keyed snapshot', hf.getCachedHuggingfaceCatalogue() === null)
}

// ============================================================================
section('§4 OpenRouter key usage — the credits belong to the key that polled them')
// ============================================================================
{
  const usage = await import('../../src/services/providers/openrouter/openrouterUsageState.ts')
  usage.__resetOpenrouterUsageStateForTest()
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-KEYA000000000000000000'
  const a = { n: 0, auth: [] as string[] }
  const polled = await usage.refreshOpenrouterKeyUsage({ force: true, fetchImpl: countingFetch({ data: { usage: 12.5, limit: 100, limit_remaining: 87.5 } }, a) })
  check('key A polls its credits', a.n === 1 && polled?.usage === 12.5 && usage.openrouterObservedKeyUsage().usage?.limitRemaining === 87.5)
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-KEYB000000000000000000'
  check("key B reads NOTHING observed (never A's credits)", usage.openrouterObservedKeyUsage().usage === null)
  const b = { n: 0, auth: [] as string[] }
  const own = await usage.refreshOpenrouterKeyUsage({ fetchImpl: countingFetch({ data: { usage: 0.25, limit: null, limit_remaining: null } }, b) })
  check('key B polls immediately (no TTL carried over) under its own bearer', b.n === 1 && b.auth[0] === 'Bearer sk-or-v1-KEYB000000000000000000' && own?.usage === 0.25)
  delete process.env.OPENROUTER_API_KEY
  check('no key ⇒ nothing observed', usage.openrouterObservedKeyUsage().usage === null)
}

// ============================================================================
section('§5 DeepSeek balance — per key')
// ============================================================================
{
  const ds = await import('../../src/services/providers/deepseek/deepseekUsageState.ts')
  ds.__resetDeepseekUsageForTest()
  const body = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] }
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-KEY-A-000000'
  const a = { n: 0, auth: [] as string[] }
  await ds.refreshDeepseekBalance({ force: true, fetchImpl: countingFetch(body, a) })
  check('key A probes its balance', a.n === 1 && ds.deepseekObservedBalance()?.balances[0]?.totalBalance === '12.34')
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-KEY-B-000000'
  check("key B reads NOTHING observed (never A's balance)", ds.deepseekObservedBalance() === null)
  const b = { n: 0, auth: [] as string[] }
  await ds.refreshDeepseekBalance({ fetchImpl: countingFetch({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.10' }] }, b) })
  check('key B probes immediately under its own bearer', b.n === 1 && b.auth[0] === 'Bearer sk-deepseek-KEY-B-000000' && ds.deepseekObservedBalance()?.balances[0]?.totalBalance === '0.10')
  delete process.env.DEEPSEEK_API_KEY
}

// ============================================================================
section('§6 Moonshot balance — per key')
// ============================================================================
{
  const ms = await import('../../src/services/providers/moonshot/moonshotUsageState.ts')
  ms.__resetMoonshotUsageForTest()
  const body = { code: 0, data: { available_balance: 42, voucher_balance: 2, cash_balance: 40 }, scode: '0x0', status: true }
  process.env.MOONSHOT_API_KEY = 'sk-moonshot-KEY-A-000000'
  const a = { n: 0, auth: [] as string[] }
  await ms.refreshMoonshotBalance({ force: true, fetchImpl: countingFetch(body, a) })
  check('key A probes its balance', a.n === 1 && ms.moonshotObservedBalance()?.availableBalance === 42)
  process.env.MOONSHOT_API_KEY = 'sk-moonshot-KEY-B-000000'
  check("key B reads NOTHING observed (never A's balance)", ms.moonshotObservedBalance() === null)
  const b = { n: 0, auth: [] as string[] }
  await ms.refreshMoonshotBalance({ fetchImpl: countingFetch({ code: 0, data: { available_balance: 1 } }, b) })
  check('key B probes immediately under its own bearer', b.n === 1 && b.auth[0] === 'Bearer sk-moonshot-KEY-B-000000' && ms.moonshotObservedBalance()?.availableBalance === 1)
  delete process.env.MOONSHOT_API_KEY
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
