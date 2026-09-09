#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' WALLET — one owner for login entries (facade over custodians)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

const scratch = mkdtempSync(join(tmpdir(), 'prove-wallet-'))
process.env.MERCURY_CONFIG_DIR = scratch

const FIXTURE_REFRESH = 'fixture-refresh-token-NEVER-SURFACES'
const FIXTURE_ACCESS = 'fixture-access-token-NEVER-SURFACES'
writeFileSync(
  join(scratch, '.openai-auth.json'),
  JSON.stringify({
    version: 1,
    tokens: {
      idToken: '',
      accessToken: FIXTURE_ACCESS,
      refreshToken: FIXTURE_REFRESH,
      accountId: 'acct_fixture_1234567890',
      planType: 'plus',
    },
  }),
)
process.env.OPENAI_API_KEY = 'sk-fixture-key-NEVER-SURFACES'

const { walletEntries, activeWalletEntry } = await import('../../src/services/wallet/wallet.js')

{
  console.log('\n— §1 openai custodians (hermetic scratch scope) —')
  const entries = walletEntries().filter(e => e.provider === 'openai')
  check('subscription entry enumerates (existence ≠ usability)', entries.some(e => e.kind === 'subscription-oauth'))
  check('api-key entry enumerates beside it (simultaneous entries)', entries.some(e => e.kind === 'api-key' && e.id === 'openai:api-key:env'))
  const active = activeWalletEntry('openai')
  check('the arbitration owner answers (subscription wins)', active?.kind === 'subscription-oauth', JSON.stringify(active))
  check('the subscription entry carries the plan identity', walletEntries().some(e => e.provider === 'openai' && e.identity?.plan === 'plus'))
}

{
  console.log('\n— §3 the no-secret law —')
  const serialized = JSON.stringify(walletEntries())
  check('the fixture refresh token never surfaces', !serialized.includes(FIXTURE_REFRESH))
  check('the fixture access token never surfaces', !serialized.includes(FIXTURE_ACCESS))
  check('the fixture api key never surfaces', !serialized.includes('sk-fixture-key'))
}

{
  console.log('\n— §4 id stability —')
  const a = walletEntries().map(e => e.id).sort()
  const b = walletEntries().map(e => e.id).sort()
  check('two enumerations answer identical ids', JSON.stringify(a) === JSON.stringify(b))
  check('every id satisfies the grammar', a.every(id => /^(anthropic|openai):[a-z-]+(:[A-Za-z0-9_.-]+)?$/.test(id)), a.join(' '))
}

{
  console.log('\n— §5 anthropic arm (structural) —')
  const entries = walletEntries().filter(e => e.provider === 'anthropic')
  check(
    'every anthropic entry is oauth-per-slot or the api-key entry',
    entries.every(e => /^anthropic:(oauth:[^:]+|api-key:(env|helper|managed))$/.test(e.id)),
    entries.map(e => e.id).join(' '),
  )
  check('no anthropic entry carries key material', !JSON.stringify(entries).includes('sk-ant-'))
}

{
  console.log('\n— §6 the runtime ref (stage 8) —')
  const { describeAgentRuntimeRef } = await import('../../src/services/providers/primaryBackend.js')
  const ALLOWED = ['contractVersion', 'backend', 'provider', 'route', 'canonicalModel', 'family', 'walletEntryId']
  const gptRef = describeAgentRuntimeRef('gpt-5.6-sol')
  check('the ref field list is PINNED (thin by contract)', Object.keys(gptRef).every(k => ALLOWED.includes(k)), Object.keys(gptRef).join(' '))
  check('a gpt ref bills the active openai entry', typeof gptRef.walletEntryId === 'string' && gptRef.walletEntryId.startsWith('openai:'), gptRef.walletEntryId)
  const glm = describeAgentRuntimeRef('glm-5.2')
  check('the zai socket carries no entry (no custodian yet)', glm.walletEntryId === undefined)
}

{
  console.log('\n— §7 the not-logged-in gate (item A) —')
  const { notLoggedInGateDecision } = await import('../../src/services/wallet/wallet.js')
  const openaiEntry = { id: 'openai:oauth:x', provider: 'openai', kind: 'subscription-oauth', label: 'ChatGPT plus subscription', custodian: 'openai-accounts' } as const
  const anthropicEntry = { id: 'anthropic:oauth:main', provider: 'anthropic', kind: 'subscription-oauth', label: 'Claude account', custodian: 'anthropic-slots' } as const
  check('empty wallet ⇒ the full refusal', notLoggedInGateDecision([], 'anthropic').state === 'not-logged-in')
  const repro = notLoggedInGateDecision([openaiEntry], 'anthropic')
  check("the operator's repro (OpenAI-only + Anthropic model) ⇒ provider-specific steering, NEVER the red refusal", repro.state === 'provider-missing' && repro.missingProvider === 'Anthropic')
  check('the steering names /model AND /login', repro.state === 'provider-missing' && repro.steering.includes('/model') && repro.steering.includes('/login'))
  check('OpenAI-only + a GPT model ⇒ NO banner', notLoggedInGateDecision([openaiEntry], 'openai').state === 'ok')
  check('Anthropic-only + a GPT model ⇒ OpenAI named missing', ((): boolean => {
    const d = notLoggedInGateDecision([anthropicEntry], 'openai')
    return d.state === 'provider-missing' && d.missingProvider === 'OpenAI'
  })())
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.error(`❌ ${failures} WALLET PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ WALLET PROVEN (custodian union · gated active · no secrets · stable ids)')
