#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'slot-hygiene-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.ANTHROPIC_API_KEY
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const SECTION_FIX: Record<string, string> = {
  '§A': 'change signinCeilingRefusal in src/models/roads/accountSlots.ts',
  '§B': 'change scanAccountScopes in src/models/sign-in/account-ledger/scopeScan.ts, or the OAuth token save (saveOAuthTokensIfNeeded) in src/models/sign-in/credentials/auth.ts or src/models/sign-in/lifecycle/oauthLifecycle.ts so a second save replaces the stored slot',
  '§D': 'change deriveFamilySlotGroups or maskedKeyTail in src/models/roads/accountSlots.ts so a slot field never carries more than the last four characters of a key',
}
let sectionKey = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  const fix = SECTION_FIX[sectionKey]
  const failureText = fix === undefined ? detail : (detail ? detail + ' | ' : '') + 'to fix: ' + fix
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && failureText ? ` — ${failureText}` : ''}`)
}
const section = (t: string): void => {
  sectionKey = t.slice(0, 2)
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const slots = await import('../../src/models/roads/accountSlots.ts')
const scopes = await import('../../src/models/sign-in/account-ledger/scopeScan.ts')
const auth = { ...(await import('../../src/models/sign-in/credentials/auth.ts')), ...(await import('../../src/models/sign-in/lifecycle/oauthLifecycle.ts')) }
const { SUBSCRIPTION_OAUTH_SCOPES } = await import('../../src/models/sign-in/oauth/oauth.ts')

section('§A the typed ceiling refusal — boundary-exact, family-named')
{
  check('below the ceiling: no refusal (1 of 2)', slots.signinCeilingRefusal('anthropic', 1) === undefined)
  const at = slots.signinCeilingRefusal('anthropic', 2)
  check('AT the ceiling: a typed refusal with family + counts', at?.refused === true && at.family === 'anthropic' && at.ceiling === 2 && at.current === 2, JSON.stringify(at))
  check('the refusal message names the remedy (sign out / re-login allowed)', (at?.message ?? '').includes('sign out') && (at?.message ?? '').includes('re-login'), at?.message)
  const openaiAt = slots.signinCeilingRefusal('openai', 2)
  check('openai carries the same 2-ceiling', openaiAt?.refused === true && openaiAt.ceiling === 2)
  check('an unruled family NEVER refuses (no invented ceiling)', slots.signinCeilingRefusal('deepseek', 99) === undefined && slots.signinCeilingRefusal('zai', 99) === undefined)
}

section('§B the structural universe — one scope, replace-on-save')
{
  const scan = scopes.scanAccountScopes()
  check('the anthropic scope universe is EXACTLY the resolved home (1 scope, current)', scan.length === 1 && scan[0]?.isCurrent === true, JSON.stringify(scan.map(s => s.name)))
  const seed = (accessToken: string) =>
    auth.saveOAuthTokensIfNeeded({
      accessToken,
      refreshToken: `rt-${accessToken}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: [...SUBSCRIPTION_OAUTH_SCOPES],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    } as never)
  seed('at-first-account')
  auth.clearOAuthTokenCache()
  seed('at-second-account')
  auth.clearOAuthTokenCache()
  const stored = auth.getClaudeAIOAuthTokens()
  check('a second OAuth save REPLACES the slot (never a concurrent add)', stored?.accessToken === 'at-second-account' && stored?.refreshToken === 'rt-at-second-account')
}


section('§D masked tails — planted long keys never surface beyond last-four')
{
  const KEY = (name: string): string => `sk-${name}-SECRETBODY-0123456789abcdef-${name}TAIL`
  const reads: import('../../src/models/roads/accountSlots.ts').AccountSlotReads = {
    scanScopes: () => [{ name: 'primary', dir: process.env.MERCURY_CONFIG_DIR!, isCurrent: true, hasConfig: false, foreignHarness: false, authed: true }] as never,
    anthropicApiKey: () => ({ key: KEY('anthropic'), source: 'credentials.keyCommand' as never }),
    zaiEnvKey: () => KEY('zai'),
    openrouterEnvKey: () => KEY('openrouter'),
    geminiEnvGeminiKey: () => KEY('gemini'),
    moonshotEnvKey: () => KEY('moonshot'),
    deepseekEnvKey: () => KEY('deepseek'),
    compatEnvKey: () => KEY('compat'),
    huggingfaceEnvKey: () => KEY('huggingface'),
    localEnvKey: () => KEY('local'),
  }
  const groups = slots.deriveFamilySlotGroups(undefined, reads)
  const allSlots = groups.flatMap(g => g.slots)
  check('the derivation produced slot rows to census', allSlots.length > 0, `groups=${groups.length}`)
  const leaks: string[] = []
  for (const slot of allSlots) {
    for (const [field, value] of Object.entries(slot)) {
      if (typeof value !== 'string') continue
      if (value.includes('SECRETBODY')) leaks.push(`${slot.family}.${field}`)
    }
  }
  check('NO slot string field carries a key body (tails only)', leaks.length === 0, leaks.join(', '))
  const tailed = allSlots.filter(s => /…[A-Za-z0-9]{4}\b/.test(`${s.identity}`))
  check('key-backed slots surface the …tail form', tailed.length >= 3, `tailed=${tailed.length} of ${allSlots.length}`)
  check('maskedKeyTail boundaries: short values yield nothing', slots.maskedKeyTail('short') === '' && slots.maskedKeyTail(undefined) === '' && slots.maskedKeyTail('0123456789') === '…6789')
}


console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
