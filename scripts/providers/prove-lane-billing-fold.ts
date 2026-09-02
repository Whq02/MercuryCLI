#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-lane-billing-fold.ts — the ONE billing-refusal
//  owner every dispatch lane feeds (laneBillingState), and the runtimes that
//  feed it.
//
//    §1 the owner: a recorded refusal reads credit-exhausted with the wire's
//       words and the lane's remedy; a settled turn clears it; lanes never
//       cross; the proof seam empties everything
//    §2 the live read bundle: resolveProviderUsability (no injected reads)
//       reads THIS owner — a refusal recorded on the openrouter lane makes
//       the live openrouter row not usable under a fixture credential, and a
//       settled turn restores it (the HF lane keeps its own status-driven
//       owner and stays untouched by this record)
//    §3 the feeders (structural): the compat runtime (seven lanes), the
//       OpenAI Responses runtime and the Z.AI runtime each record a
//       billing_error terminal fault AND clear on a settled turn — the
//       symmetry that keeps a topped-up account from reading dead forever
//
//  Run: ~/.bun/bin/bun run scripts/providers/prove-lane-billing-fold.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'HF_TOKEN',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-lane-billing-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
const billing = await import('../../src/services/providers/laneBillingState.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')

// ============================================================================
section('§1 the owner: record · read · clear · isolation')
// ============================================================================
{
  billing.__resetLaneBillingStateForTest()
  check('nothing observed ⇒ clear (absence of evidence, never a balance claim)', billing.laneBillingState('deepseek').state === 'clear')
  billing.recordLaneBillingRefusal('deepseek', { detail: 'http-402: Insufficient Balance', remedy: 'top up the DeepSeek account.' }, () => 1_756_000_000_000)
  const refused = billing.laneBillingState('deepseek')
  check(
    'a recorded refusal reads credit-exhausted with the wire words, the remedy and the stamp',
    refused.state === 'credit-exhausted' && refused.detail === 'http-402: Insufficient Balance' && refused.remedy === 'top up the DeepSeek account.' && refused.observedAtMs === 1_756_000_000_000,
    JSON.stringify(refused),
  )
  check('another lane stays clear (no cross-lane leak)', billing.laneBillingState('moonshot').state === 'clear' && billing.laneBillingState('openai').state === 'clear')
  billing.recordLaneTurnSettled('moonshot')
  check('settling a DIFFERENT lane leaves the refusal standing', billing.laneBillingState('deepseek').state === 'credit-exhausted')
  billing.recordLaneTurnSettled('deepseek')
  check('a settled turn on the lane clears it', billing.laneBillingState('deepseek').state === 'clear')
  billing.recordLaneBillingRefusal('zai', { detail: 'zai-1113: balance', remedy: 'r' })
  billing.recordLaneBillingRefusal('openai', { detail: 'http-402', remedy: 'r' })
  billing.__resetLaneBillingStateForTest()
  check('the proof seam empties every lane', billing.laneBillingState('zai').state === 'clear' && billing.laneBillingState('openai').state === 'clear')
}

// ============================================================================
section('§2 the live read bundle reads the owner')
// ============================================================================
{
  billing.__resetLaneBillingStateForTest()
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-BILLINGFOLDPROOF000000000'
  const before = resolveProviderUsability().openrouter
  check('fixture credential, nothing observed ⇒ the openrouter row is usable', before.usable === true && before.credential === 'api-key', JSON.stringify(before))
  billing.recordLaneBillingRefusal('openrouter', {
    detail: 'http-402: insufficient credits',
    remedy: 'the OpenRouter account has insufficient credits — add credits, then retry; /model picks another model meanwhile.',
  })
  const refused = resolveProviderUsability().openrouter
  check(
    'a recorded refusal makes the LIVE openrouter row not usable, blocker = wire words + the lane remedy',
    refused.usable === false && refused.blockers.some(b => b.includes('insufficient credits') && b.includes('add credits') && b.includes('A successful turn clears this')),
    JSON.stringify(refused.blockers),
  )
  const hf = resolveProviderUsability().huggingface
  check('the Hugging Face row is untouched by this record (its own owner governs)', !hf.blockers.some(b => b.includes('refused the last turn for billing')))
  billing.recordLaneTurnSettled('openrouter')
  const restored = resolveProviderUsability().openrouter
  check('a settled turn restores the live row', restored.usable === true && restored.blockers.length === 0)
  delete process.env.OPENROUTER_API_KEY
}

// ============================================================================
section('§3 the feeders record AND clear (structural pins)')
// ============================================================================
{
  for (const [file, lane] of [
    ['src/services/providers/openaicompat/compatChatCallModel.ts', 'profile.lane'],
    ['src/services/providers/openai/openaiCallModel.ts', "'openai'"],
    ['src/services/providers/zai/zaiCallModel.ts', "'zai'"],
  ] as const) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    check(
      `${file.split('/').at(-1)}: records a billing_error refusal on ${lane}`,
      source.includes(`recordLaneBillingRefusal(${lane}`) && /typed === 'billing_error'/.test(source),
    )
    check(`${file.split('/').at(-1)}: clears on a settled turn (${lane})`, source.includes(`recordLaneTurnSettled(${lane})`))
  }
  const usability = readFileSync(join(ROOT, 'src/services/providers/providerUsability.ts'), 'utf8')
  // Eight applied lanes: openai · zai · moonshot · deepseek · openai-compat ·
  // openrouter · gemini · local (anthropic has no wire-billing class here;
  // huggingface keeps its status-driven owner).
  check(
    'the usability resolver reads the owner for every non-HF engine lane (8 applications)',
    usability.includes("require('./laneBillingState.js')") && (usability.match(/applyLaneBilling\(/g) ?? []).length === 8,
    String((usability.match(/applyLaneBilling\(/g) ?? []).length),
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
