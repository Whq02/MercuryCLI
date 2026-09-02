#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-primary-backend.ts
//  PROOF: the typed PrimaryAgentBackend
//  contract over the zai+openai+anthropic callModel seam.
//
//    1. ROUTING AGREEMENT: resolvePrimaryAgentBackend and the callModel
//       route law agree on every id shape (they read the same law — proved,
//       not assumed).
//    2. TYPED REFS: describeAgentRuntimeRef is TOTAL — gpt ids parse to
//       family/generation/variant; glm/claude/unknown classify; the contract
//       version stamps every ref.
//    3. READINESS HONESTY: an engine backend without material ⇒ unavailable
//       naming the
//       source; key-present-no-turn ⇒ 'configured' (NEVER ready without a
//       settled live turn); anthropic ⇒ ready by construction.
//    4. PROJECTION AGREEMENT: the /doctor readiness rows (collectReadiness)
//       carry EXACTLY the backend receipts' states — one truth, projected.
//    5. A7 usage-limit honesty: the 429 fault carries reset header facts;
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-primary-backend.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' A1 — typed PrimaryAgentBackend contract proof')
console.log('============================================================')

// Hermetic env bracket.
const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'MERCURY_LOCAL_PROBE_TARGETS',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  savedEnv[key] = process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'prove-apex-a1-'))
delete process.env.OPENAI_API_KEY
delete process.env.ZAI_API_KEY
delete process.env.OPENROUTER_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.GOOGLE_API_KEY
delete process.env.HF_TOKEN
// No local-server probe leaves this process (the local lane reads its
// discovery cache; an absent cache is the honest unavailable state).
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { resolvePrimaryAgentBackend, describeAgentRuntimeRef, APEX_BACKEND_CONTRACT_VERSION } =
  await import('../../src/services/providers/primaryBackend.js')
const { classifyModelRoute, declaredRouteOf } = await import('../../src/services/providers/callModelRouter.js')
const { collectReadiness } = await import('../../src/utils/readiness.js')
const { mapOpenaiHttpFailure } = await import('../../src/services/providers/openai/openaiWire.js')

// ----------------------------------------------------------------------------
section('1 · routing agreement across id shapes')
// ----------------------------------------------------------------------------
{
  const cases: Array<[string, string]> = [
    ['gpt-5.6-sol', 'openai'],
    ['gpt', 'openai'],
    ['GPT-5.6-TERRA', 'openai'],
    ['glm-5.2', 'zai'],
    ['glm', 'zai'],
    ['claude-opus-4-8', 'anthropic'],
    ['claude-fable-5[1m]', 'anthropic'],
    // The carrier and served lanes: recognized AND live (a placeholder
    // receipt over a live wire is the class this pins shut).
    ['openrouter/anthropic/claude-opus-5', 'openrouter'],
    ['gemini-3-pro', 'gemini'],
    ['huggingface/openai/gpt-oss-120b', 'huggingface'],
    ['local/qwen3:8b', 'local'],
    ['kimi-k3', 'moonshot'],
    ['deepseek-v4-pro', 'deepseek'],
    ['compat/qwen3-32b', 'openai-compat'],
  ]
  for (const [id, expectedProvider] of cases) {
    const backend = resolvePrimaryAgentBackend(id)
    const route = declaredRouteOf(id)
    check(
      `'${id}' → ${expectedProvider} (backend ≡ route)`,
      backend !== null && backend.provider === expectedProvider && route === expectedProvider,
      `backend=${backend?.provider} route=${route}`,
    )
  }
  // RE-PINNED twice (the operator's phase-2 neutrality ruling): 'nonsense-id'
  // was the remainder-era row here (backend ≡ route ≡ anthropic by leftover);
  // the remainder-era classifier is now RETIRED, so the stranger resolves NO
  // backend and the verdict names it honestly.
  check(
    "'nonsense-id' resolves NO backend and classifies 'unrecognised' — never a borrowed family",
    resolvePrimaryAgentBackend('nonsense-id') === null && classifyModelRoute('nonsense-id').kind === 'unrecognised',
  )
}

// ----------------------------------------------------------------------------
section('2 · typed refs are total')
// ----------------------------------------------------------------------------
{
  const sol = describeAgentRuntimeRef('gpt-5.6-sol')
  check(
    'gpt-5.6-sol → {gpt, 5.6, sol} on openai-responses',
    sol.family.kind === 'gpt' && sol.family.major === 5 && sol.family.minor === 6 && sol.family.variant === 'sol' && sol.backend === 'openai-responses',
  )
  check('contract version stamps every ref', sol.contractVersion === APEX_BACKEND_CONTRACT_VERSION)
  const opus = describeAgentRuntimeRef('claude-opus-4-8')
  check('claude id → claude family on the main loop', opus.family.kind === 'claude' && opus.backend === 'anthropic-messages')
  const glm = describeAgentRuntimeRef('glm-5.2')
  check('glm id → glm family on zai-glm', glm.family.kind === 'glm' && glm.backend === 'zai-glm')
  const junk = describeAgentRuntimeRef(undefined)
  // RE-PINNED (the operator's phase-2 neutrality ruling): no-id-at-all is
  // ABSENCE, never the home route's identity — the ref stays total but
  // honest: unknown family, route 'absence', NO backend, NO provider.
  check(
    'undefined stays total AND honest (unknown family, absence route, no backend/provider)',
    junk.family.kind === 'unknown' && junk.route === 'absence' && junk.backend === undefined && junk.provider === undefined,
  )
  const stranger = describeAgentRuntimeRef('banana-brew-9')
  check(
    "an id no family declares refs as 'unrecognised' — never a borrowed family",
    stranger.family.kind === 'unknown' && stranger.route === 'unrecognised' && stranger.backend === undefined && stranger.provider === undefined,
  )
  check(
    'the backend resolver answers null for the stranger and for absence (no borrowed backend identity)',
    resolvePrimaryAgentBackend('banana-brew-9') === null && resolvePrimaryAgentBackend(undefined) === null && resolvePrimaryAgentBackend('claude-opus-4-8') !== null,
  )
  const carrier = describeAgentRuntimeRef('openrouter/anthropic/claude-opus-5')
  check(
    'a Claude slug behind OpenRouter is the openrouter family on openrouter-chat — never the claude family',
    carrier.family.kind === 'openrouter' && carrier.backend === 'openrouter-chat' && carrier.provider === 'openrouter',
    JSON.stringify(carrier),
  )
  const gemini = describeAgentRuntimeRef('gemini-3-pro')
  check('a gemini id → gemini family on gemini-generate', gemini.family.kind === 'gemini' && gemini.backend === 'gemini-generate')
}

// ----------------------------------------------------------------------------
section('3 · readiness honesty')
// ----------------------------------------------------------------------------
{
  check('anthropic ready by construction', resolvePrimaryAgentBackend('claude-opus-4-8').readiness().state === 'ready')

  const noAccount = resolvePrimaryAgentBackend('gpt-5.6-sol').readiness()
  check('no account: unavailable naming the source', noAccount.state === 'unavailable' && noAccount.reason.includes('account'))
  const noKey = resolvePrimaryAgentBackend('glm-5.2').readiness()
  check('no key: zai unavailable naming ZAI_API_KEY', noKey.state === 'unavailable' && noKey.reason.includes('ZAI_API_KEY'))
  process.env.ZAI_API_KEY = 'zai-fake-key-for-proof'
  const zaiConfigured = resolvePrimaryAgentBackend('glm-5.2').readiness()
  check("key present, no live turn: 'configured' — NEVER ready", zaiConfigured.state === 'configured')
  process.env.OPENAI_API_KEY = 'sk-fake-key-for-proof'
  const openaiConfigured = resolvePrimaryAgentBackend('gpt-5.6-sol').readiness()
  check("api key present, no live turn: 'configured' — NEVER ready", openaiConfigured.state === 'configured' && openaiConfigured.detail.includes('no live turn'))

  // The carrier lanes carry REAL receipts from their owning resolvers — the
  // old "recognized — the runtime folds in from the provider-auth lane"
  // placeholder over a live wire is the lie this section closes.
  const noOpenrouter = resolvePrimaryAgentBackend('openrouter/anthropic/claude-opus-5').readiness()
  check(
    'no OpenRouter credential: unavailable naming OPENROUTER_API_KEY (never the fold placeholder)',
    noOpenrouter.state === 'unavailable' && noOpenrouter.reason.includes('OPENROUTER_API_KEY') && !/folds in/.test(noOpenrouter.reason),
    JSON.stringify(noOpenrouter),
  )
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-fake-key-for-proof'
  const openrouterConfigured = resolvePrimaryAgentBackend('openrouter/anthropic/claude-opus-5').readiness()
  check("OpenRouter key present, no live turn: 'configured' naming the key source", openrouterConfigured.state === 'configured' && openrouterConfigured.detail.includes('OPENROUTER_API_KEY') && openrouterConfigured.detail.includes('no live turn'))
  const noGemini = resolvePrimaryAgentBackend('gemini-3-pro').readiness()
  check(
    'no Gemini credential: unavailable naming GEMINI_API_KEY (never the fold placeholder)',
    noGemini.state === 'unavailable' && noGemini.reason.includes('GEMINI_API_KEY') && !/folds in/.test(noGemini.reason),
    JSON.stringify(noGemini),
  )
  process.env.GEMINI_API_KEY = 'AIza-fake-key-for-proof'
  const geminiConfigured = resolvePrimaryAgentBackend('gemini-3-pro').readiness()
  check("Gemini key present, no live turn: 'configured' naming the source", geminiConfigured.state === 'configured' && geminiConfigured.detail.includes('GEMINI_API_KEY') && geminiConfigured.detail.includes('no live turn'))
  const noHf = resolvePrimaryAgentBackend('huggingface/openai/gpt-oss-120b').readiness()
  check('no Hugging Face credential: unavailable naming HF_TOKEN', noHf.state === 'unavailable' && noHf.reason.includes('HF_TOKEN'))
  const noLocal = resolvePrimaryAgentBackend('local/qwen3:8b').readiness()
  check('no local server: unavailable naming the discovery route', noLocal.state === 'unavailable' && noLocal.reason.includes('MERCURY_LOCAL_BASE_URL'))
}

// ----------------------------------------------------------------------------
section('4 · the /doctor rows PROJECT the backend receipts')
// ----------------------------------------------------------------------------
{
  const report = collectReadiness()
  const openaiRow = report.records.find(r => r.id === 'engine:backend:openai-responses')
  const zaiRow = report.records.find(r => r.id === 'engine:backend:zai-glm')
  const openaiReceipt = resolvePrimaryAgentBackend('gpt-5.6-sol').readiness()
  const zaiReceipt = resolvePrimaryAgentBackend('glm-5.2').readiness()
  check(
    'engine:openai row state ≡ the backend receipt',
    openaiRow?.state === openaiReceipt.state,
    `row=${openaiRow?.state} receipt=${openaiReceipt.state}`,
  )
  check(
    'engine:zai row state ≡ the backend receipt',
    zaiRow?.state === zaiReceipt.state,
    `row=${zaiRow?.state} receipt=${zaiReceipt.state}`,
  )
  check(
    'the rows name the backend receipt as their source',
    openaiRow?.source === 'primary-backend readiness receipt' &&
      zaiRow?.source === 'primary-backend readiness receipt',
  )
  // EVERY landed family projects a row — the carrier and served lanes
  // included (four families had no row at all; two carried a placeholder).
  const expected: Array<[string, string]> = [
    ['engine:backend:anthropic-messages', 'claude-opus-4-8'],
    ['engine:backend:openai-responses', 'gpt-5.6-sol'],
    ['engine:backend:zai-glm', 'glm-5.2'],
    ['engine:backend:moonshot-chat', 'kimi-k3'],
    ['engine:backend:deepseek-chat', 'deepseek-v4-pro'],
    ['engine:backend:openai-compat-chat', 'compat/qwen3-32b'],
    ['engine:backend:openrouter-chat', 'openrouter/anthropic/claude-opus-5'],
    ['engine:backend:gemini-generate', 'gemini-3-pro'],
    ['engine:backend:huggingface-chat', 'huggingface/openai/gpt-oss-120b'],
    ['engine:backend:local-chat', 'local/qwen3:8b'],
  ]
  for (const [rowId, model] of expected) {
    const row = report.records.find(r => r.id === rowId)
    const receipt = resolvePrimaryAgentBackend(model).readiness()
    check(
      `${rowId} row exists and its state ≡ the backend receipt (${receipt.state})`,
      row !== undefined && row.state === receipt.state,
      `row=${row?.state} receipt=${receipt.state}`,
    )
  }
  const openrouterRow = report.records.find(r => r.id === 'engine:backend:openrouter-chat')
  check(
    'the OpenRouter row (key present) reads configured with the key source, never the fold placeholder',
    openrouterRow?.state === 'configured' && !/folds in/.test(openrouterRow.detail ?? ''),
    JSON.stringify(openrouterRow),
  )
  for (const rowId of ['engine:backend:huggingface-chat', 'engine:backend:local-chat']) {
    const row = report.records.find(r => r.id === rowId)
    check(`${rowId}: an unavailable lane carries its own remedy`, row?.state === 'unavailable' && typeof row.remedy === 'string' && row.remedy.length > 10, JSON.stringify(row))
  }
}

// ----------------------------------------------------------------------------
section('5 · A7 — usage-limit honesty (typed facts, no invented resets)')
// ----------------------------------------------------------------------------
{
  const fault = mapOpenaiHttpFailure(
    429,
    { error: { code: 'rate_limit_exceeded', message: 'window reached' } },
    { get: (name: string) => (name === 'retry-after' ? '3600' : null) },
  )
  check("429 → kind 'usage-limit' with the reset fact appended", fault.kind === 'usage-limit' && fault.message.includes('retry-after: 3600'))
  const bare = mapOpenaiHttpFailure(429, {})
  check('429 without headers stays typed (no invented reset)', bare.kind === 'usage-limit' && !bare.message.includes('retry-after'))
}

// Restore env.
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL PRIMARY-BACKEND PROOFS PASS')
else console.log(`${failures} PRIMARY-BACKEND PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
