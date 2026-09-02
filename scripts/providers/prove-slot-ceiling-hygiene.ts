#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-slot-ceiling-hygiene.ts — spec-05 C4: the sign-in
//  ceiling as a STRUCTURAL fact with a typed refusal at its boundary, and
//  the masked-tail hygiene of every slot the board derives.
//
//    §A the typed refusal — undefined below the ceiling, refused AT it with
//       family/counts/remedy in the message; families without a ruled
//       ceiling never refuse
//    §B the structural universe — the anthropic scope scan is EXACTLY the
//       resolved config home (one scope; a third concurrent OAuth sign-in
//       has no path to exist), and the anthropic credential store REPLACES
//       on save (two saves ⇒ the second stands alone)
//    §C the sign-in entry enumeration (source pins) — every family leg an
//       operator can open lives in the ONE flow (ConsoleOAuthFlow), and the
//       ceilinged families' headers read the ceiling on /accounts
//    §D masked tails — long keys planted in EVERY family's injected reads
//       surface at most their last-four tail in ANY slot string field;
//       maskedKeyTail's own boundaries hold
//    §E the /accounts family health line reads the ONE resolver and renders
//       blockers verbatim (source pins)
//
//  Hermetic: scratch config home, injected reads, no network, no login.
//
//  Run: ~/.bun/bin/bun run scripts/providers/prove-slot-ceiling-hygiene.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
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
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const slots = await import('../../src/services/providers/accountSlots.ts')
const scopes = await import('../../src/utils/accounts/scopeScan.ts')
const auth = await import('../../src/utils/auth.ts')
const { CLAUDE_AI_OAUTH_SCOPES } = await import('../../src/constants/oauth.ts')

// ============================================================================
section('§A the typed ceiling refusal — boundary-exact, family-named')
// ============================================================================
{
  check('below the ceiling: no refusal (1 of 2)', slots.signinCeilingRefusal('anthropic', 1) === undefined)
  const at = slots.signinCeilingRefusal('anthropic', 2)
  check('AT the ceiling: a typed refusal with family + counts', at?.refused === true && at.family === 'anthropic' && at.ceiling === 2 && at.current === 2, JSON.stringify(at))
  check('the refusal message names the remedy (sign out / re-login allowed)', (at?.message ?? '').includes('sign out') && (at?.message ?? '').includes('re-login'), at?.message)
  const openaiAt = slots.signinCeilingRefusal('openai', 2)
  check('openai carries the same 2-ceiling', openaiAt?.refused === true && openaiAt.ceiling === 2)
  check('an unruled family NEVER refuses (no invented ceiling)', slots.signinCeilingRefusal('deepseek', 99) === undefined && slots.signinCeilingRefusal('zai', 99) === undefined)
}

// ============================================================================
section('§B the structural universe — one scope, replace-on-save')
// ============================================================================
{
  const scan = scopes.scanAccountScopes()
  check('the anthropic scope universe is EXACTLY the resolved home (1 scope, current)', scan.length === 1 && scan[0]?.isCurrent === true, JSON.stringify(scan.map(s => s.name)))
  const seed = (accessToken: string) =>
    auth.saveOAuthTokensIfNeeded({
      accessToken,
      refreshToken: `rt-${accessToken}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: [...CLAUDE_AI_OAUTH_SCOPES],
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

// ============================================================================
section('§C the sign-in entry enumeration — one flow, headers read the ceiling')
// ============================================================================
{
  const flow = readFileSync(join(ROOT, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  for (const leg of ["'claudeai'", "'console'", "'openai'", "'openrouter'", "'gemini'", "'huggingface'", "'moonshot'", "'zai'", "'deepseek'"]) {
    check(`the ${leg} sign-in leg lives in the ONE flow`, flow.includes(leg))
  }
  const board = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('/accounts headers read familySigninCeiling (the headroom words)', board.includes('familySigninCeiling'))
  const loginCommand = readFileSync(join(ROOT, 'src/commands/login/login.tsx'), 'utf8')
  check('/login and /logins mount that one flow', loginCommand.includes('ConsoleOAuthFlow'))
}

// ============================================================================
section('§D masked tails — planted long keys never surface beyond last-four')
// ============================================================================
{
  const KEY = (name: string): string => `sk-${name}-SECRETBODY-0123456789abcdef-${name}TAIL`
  const reads: import('../../src/services/providers/accountSlots.ts').AccountSlotReads = {
    scanScopes: () => [{ name: 'primary', dir: process.env.MERCURY_CONFIG_DIR!, isCurrent: true, hasConfig: false, claudeFamily: false, authed: true }] as never,
    anthropicApiKey: () => ({ key: KEY('anthropic'), source: 'apiKeyHelper' as never }),
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

// ============================================================================
section('§E the /accounts health line — the ONE resolver, blockers verbatim')
// ============================================================================
{
  const board = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  check('the family header health line reads resolveProviderUsability', board.includes('resolveProviderUsability'))
  check('a not-ready family renders its blocker VERBATIM (blockers[0])', board.includes('health.blockers[0]'))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
