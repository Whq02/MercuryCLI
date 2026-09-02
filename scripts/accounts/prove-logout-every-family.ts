#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-logout-every-family.ts — /logout signs out of
// EVERY provider family (ledger L21).
//
//  THE FIND: the command's receipt read "Logged out of all your accounts."
//  while performLogout tore down only the Anthropic side, the ChatGPT
//  subscription and the stored OpenAI + Z.AI keys — the OAuth-minted
//  OpenRouter key, the Google, Kimi and Hugging Face sign-ins and seven
//  stored keys (openrouter · gemini · moonshot · deepseek · compat ·
//  huggingface · local) survived a "logout of everything".
//
//  THE LAW: /logout runs every engine family through the ONE per-slot owner
//  the /accounts board's ⌫ fires (accountSlots.signOutEveryEngineCredential);
//  a store the switch can remove is a store /logout removes. Env-pinned
//  keys are the shell's and stay.
//
//    §1 BEFORE — every store seeded on a scratch home reads PRESENT through
//       its own resolver (a mis-shaped seed reds here; nothing passes
//       vacuously);
//    §2 the everything-verb — performLogout on the real owners: every
//       resolver reads absent, every auth file lost its tokens/minted key
//       (non-secret facts like the Kimi region and the Gemini client stay,
//       as the per-slot notes promise), the secrets file holds no key, the
//       Anthropic credential file is gone, the secrets file stays mode 600;
//    §3 the structure — /logout calls the one owner and names no family
//       owner of its own; every engine route the removal switch knows has a
//       row in the everything-verb (the two lists can never drift apart).
//
//  POISON (recorded, not automated): against the base performLogout the §2
//  legs for openrouter · gemini · moonshot · huggingface · deepseek · compat
//  · local read PRESENT after the logout.
//
//  Hermetic: scratch config home pinned before any owner loads, the file
//  credential plane, every provider base dead, ambient credentials cleared,
//  no Anthropic OAuth token seeded (so no revoke leg ever leaves the box).
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-logout-every-family.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' /logout — every family, through the one per-slot owner')
console.log('============================================================')

// ── hermetic ground ─────────────────────────────────────────────────────────
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_USAGE_SEED',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
const scratch = mkdtempSync(join(tmpdir(), 'prove-logout-every-family-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const dead = 'http://127.0.0.1:1'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
]) {
  process.env[base] = dead
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const secrets = await import('../../src/utils/router/providerSecrets.js')
const openai = await import('../../src/services/providers/openai/openaiAccounts.js')
const openrouter = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
const gemini = await import('../../src/services/providers/gemini/geminiAccounts.js')
const moonshot = await import('../../src/services/providers/moonshot/moonshotAccounts.js')
const huggingface = await import('../../src/services/providers/huggingface/huggingfaceAccounts.js')

const far = Date.now() + 365 * 24 * 3600_000
const authFile = (name: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(home, name), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ── §1 the seeds, read back through the owners ──────────────────────────────
section('§1 before — every family PRESENT through its own resolver')
{
  // The stored keys ride the owners' own writers (every family).
  secrets.writeStoredOpenaiApiKey('sk-fixture-openai')
  secrets.writeStoredZaiApiKey('fixture-zai', 'coding')
  secrets.writeStoredOpenrouterApiKey('sk-or-fixture-stored')
  secrets.writeStoredGeminiApiKey('fixture-gemini')
  secrets.writeStoredMoonshotApiKey('fixture-moonshot')
  secrets.writeStoredDeepseekApiKey('fixture-deepseek')
  secrets.writeStoredCompatApiKey('fixture-compat')
  secrets.writeStoredHuggingfaceApiKey('hf_fixture_stored')
  secrets.writeStoredLocalApiKey('fixture-local')
  // The OAuth sign-ins: the owners' writers where one is exported, else the
  // documented file shape (openaiAccounts · openrouterAccounts ·
  // geminiAccounts declare theirs at their "Stored auth" sections).
  moonshot.writeMoonshotTokens({ accessToken: 'kimi-fixture-access', refreshToken: 'kimi-fixture-refresh', accessTokenExpiresAtMs: far }, 'global')
  huggingface.writeHuggingfaceTokens(
    { accessToken: 'hf-fixture-access', refreshToken: 'hf-fixture-refresh', accessTokenExpiresAtMs: far },
    { username: 'fixture', observedAtMs: Date.now() },
  )
  writeFileSync(
    join(home, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus', accessTokenExpiresAtMs: far },
    }),
  )
  writeFileSync(
    join(home, '.openrouter-auth.json'),
    JSON.stringify({ version: 1, minted: { key: 'sk-or-v1-fixture-minted', mintedAtMs: Date.now(), label: 'Mercury' } }),
  )
  writeFileSync(
    join(home, '.gemini-auth.json'),
    JSON.stringify({
      version: 1,
      client: { clientId: 'fixture-client-id' },
      tokens: { accessToken: 'g-fixture-access', refreshToken: 'g-fixture-refresh', accessTokenExpiresAtMs: far },
    }),
  )

  check('openai: the ChatGPT subscription reads connected', openai.subscriptionConnected())
  check('openai: the stored key reads present', secrets.readStoredOpenaiApiKey() !== undefined)
  check('zai: the stored key + its plan read present', secrets.readStoredZaiApiKey() !== undefined && secrets.readStoredZaiKeyPlan() === 'coding')
  check('openrouter: the OAuth-minted key reads present', openrouter.readMintedOpenrouterKey() !== undefined)
  check('openrouter: the stored key reads present', secrets.readStoredOpenrouterApiKey() !== undefined)
  check('gemini: the Google sign-in reads connected', gemini.geminiOauthConnected())
  check('gemini: the stored key reads present', secrets.readStoredGeminiApiKey() !== undefined)
  check('moonshot: the Kimi sign-in reads present', moonshot.moonshotStoredTokens() !== undefined)
  check('moonshot: the stored key reads present', secrets.readStoredMoonshotApiKey() !== undefined)
  check('huggingface: the device-flow sign-in reads present', huggingface.huggingfaceStoredTokens() !== undefined)
  check('huggingface: the stored token reads present', secrets.readStoredHuggingfaceApiKey() !== undefined)
  check('deepseek: the stored key reads present', secrets.readStoredDeepseekApiKey() !== undefined)
  check('compat: the stored key reads present', secrets.readStoredCompatApiKey() !== undefined)
  check('local: the stored key reads present', secrets.readStoredLocalApiKey() !== undefined)
}

// ── §2 the everything-verb ──────────────────────────────────────────────────
section('§2 performLogout — every store empties through the one owner')
{
  const { performLogout } = await import('../../src/commands/logout/logout.js')
  await performLogout()

  check('openai: the ChatGPT subscription is disconnected', !openai.subscriptionConnected())
  check('openai: the stored key is gone', secrets.readStoredOpenaiApiKey() === undefined)
  check('zai: the stored key and its plan are gone', secrets.readStoredZaiApiKey() === undefined && secrets.readStoredZaiKeyPlan() === undefined)
  check('openrouter: the OAuth-minted key is gone', openrouter.readMintedOpenrouterKey() === undefined)
  check('openrouter: the stored key is gone', secrets.readStoredOpenrouterApiKey() === undefined)
  check('gemini: the Google sign-in is disconnected', !gemini.geminiOauthConnected())
  check('gemini: the stored key is gone', secrets.readStoredGeminiApiKey() === undefined)
  check('moonshot: the Kimi sign-in is disconnected', moonshot.moonshotStoredTokens() === undefined)
  check('moonshot: the stored key is gone', secrets.readStoredMoonshotApiKey() === undefined)
  check('huggingface: the device-flow sign-in is disconnected', huggingface.huggingfaceStoredTokens() === undefined)
  check('huggingface: the stored token is gone', secrets.readStoredHuggingfaceApiKey() === undefined)
  check('deepseek: the stored key is gone', secrets.readStoredDeepseekApiKey() === undefined)
  check('compat: the stored key is gone', secrets.readStoredCompatApiKey() === undefined)
  check('local: the stored key is gone', secrets.readStoredLocalApiKey() === undefined)

  // The files themselves: secrets gone, non-secret facts kept as the
  // per-slot notes promise (the Kimi region, the Gemini client config).
  const secretsFile = authFile('.provider-secrets.json')
  check(
    'the secrets file holds no key of any family',
    Object.keys(secretsFile).every(k => !/ApiKey$/.test(k)) && secretsFile.zaiKeyPlan === undefined,
    JSON.stringify(Object.keys(secretsFile)),
  )
  check('the OpenRouter auth file lost its minted key', authFile('.openrouter-auth.json').minted === undefined)
  const geminiFile = authFile('.gemini-auth.json')
  check('the Gemini auth file lost its tokens and kept the operator\'s client config', geminiFile.tokens === undefined && geminiFile.client !== undefined)
  const moonshotFile = authFile('.moonshot-auth.json')
  check('the Moonshot auth file lost its tokens and kept the region', moonshotFile.tokens === undefined && moonshotFile.region === 'global')
  const hfFile = authFile('.huggingface-auth.json')
  check('the Hugging Face auth file lost its tokens and identity', hfFile.tokens === undefined && hfFile.identity === undefined)
  check('the OpenAI auth file lost its tokens', authFile('.openai-auth.json').tokens === undefined)
  check('the Anthropic credential file is gone', !existsSync(join(home, '.credentials.json')))
  if (process.platform !== 'win32') {
    const mode = statSync(join(home, '.provider-secrets.json')).mode & 0o777
    check('the secrets file stays mode 600 after the rewrite', mode === 0o600, mode.toString(8))
  }
}

// ── §3 the structure ────────────────────────────────────────────────────────
section('§3 one owner — /logout calls it; the removal switch and the verb agree')
{
  const repo = join(import.meta.dir, '..', '..')
  const logoutSrc = readFileSync(join(repo, 'src/commands/logout/logout.tsx'), 'utf8')
  check('/logout calls signOutEveryEngineCredential', logoutSrc.includes('signOutEveryEngineCredential()'))
  check(
    '/logout names no family owner of its own (the one-owner law)',
    !logoutSrc.includes('disconnectOpenaiSubscription') && !logoutSrc.includes('writeStoredOpenaiApiKey') && !logoutSrc.includes('writeStoredZaiApiKey'),
  )
  const slotsSrc = readFileSync(join(repo, 'src/services/providers/accountSlots.ts'), 'utf8')
  const removalStart = slotsSrc.indexOf('export function executeSlotRemoval(')
  const verbStart = slotsSrc.indexOf('export function signOutEveryEngineCredential(')
  check('both owners exist in accountSlots', removalStart !== -1 && verbStart !== -1 && verbStart > removalStart)
  const switchBody = slotsSrc.slice(removalStart, verbStart)
  const verbBody = slotsSrc.slice(verbStart)
  const NOT_ENGINE = new Set(['excluded', 'owner', 'settings', 'env', 'anthropic-oauth', 'anthropic-managed-key'])
  const routes = [...switchBody.matchAll(/case '([a-z-]+)':/g)].map(m => m[1]!).filter(r => !NOT_ENGINE.has(r))
  check('the removal switch names engine routes', routes.length >= 14, String(routes.length))
  const missing = routes.filter(r => !verbBody.includes(`['${r}',`))
  check('every engine route of the removal switch has a row in the everything-verb', missing.length === 0, missing.join(', '))

  // THE FAMILY CENSUS (the lead's law): every family the estate's ONE
  // enumeration lists (the router catalogue — the list /accounts, /config
  // and /usage derive from) has a logout arm: anthropic's is performLogout's
  // own ladder (the managed key + the token store), every other family a
  // row in the verb whose route label carries the family's stem. A family
  // added to the estate without a logout arm reds HERE by census — never a
  // hand list of family words.
  const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.js')
  const families = buildRouterModelSnapshot().providers.map(p => String(p.id))
  check('the enumeration lists the ten families', families.length >= 10, families.join(', '))
  const stem = (id: string): string => (id === 'openai-compat' ? 'compat' : id)
  const armless = families.filter(id =>
    id === 'anthropic'
      ? !(logoutSrc.includes('removeApiKey()') && logoutSrc.includes('getSecureStorage().delete()'))
      : !verbBody.includes(`['${stem(id)}-`),
  )
  check('every family in the enumeration has a logout arm (anthropic: the ladder; the rest: a verb row)', armless.length === 0, armless.join(', '))
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(failures === 0 ? '\n✅ prove-logout-every-family — all checks pass' : `\n❌ prove-logout-every-family — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
