#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
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

const secrets = await import('../../src/services/providers/providerSecrets.js')
const openai = await import('../../src/services/providers/openai/openaiAccounts.js')
const openrouter = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
const gemini = await import('../../src/services/providers/gemini/geminiAccounts.js')
const moonshot = await import('../../src/services/providers/moonshot/moonshotAccounts.js')
const huggingface = await import('../../src/services/providers/huggingface/huggingfaceAccounts.js')

const xai = await import('../../src/services/providers/xai/xaiOauth.js')
xai.writeXaiTokens({ accessToken: 'fixture-xai', refreshToken: 'fixture-xai-refresh', expiresAtMs: Date.now() + 3600_000 })
check('xai: the Grok subscription is present before logout', Boolean(xai.xaiStoredTokens()))

const far = Date.now() + 365 * 24 * 3600_000
const authFile = (name: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(home, name), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

section('§1 before — every family PRESENT through its own resolver')
{
  secrets.writeStoredOpenaiApiKey('sk-fixture-openai')
  secrets.writeStoredZaiApiKey('fixture-zai', 'coding')
  secrets.writeStoredOpenrouterApiKey('sk-or-fixture-stored')
  secrets.writeStoredGeminiApiKey('fixture-gemini')
  secrets.writeStoredMoonshotApiKey('fixture-moonshot')
  secrets.writeStoredDeepseekApiKey('fixture-deepseek')
  secrets.writeStoredCompatApiKey('fixture-compat')
  secrets.writeStoredHuggingfaceApiKey('hf_fixture_stored')
  secrets.writeStoredLocalApiKey('fixture-local')
  writeFileSync(join(home, '.provider-secrets.json'), JSON.stringify({ ...authFile('.provider-secrets.json'), compatEndpointKeys: { named: 'fixture-named-endpoint' } }))
  check('a named custom endpoint key reads present before logout (F43A-C6-01)', secrets.readStoredCompatApiKey('named') === 'fixture-named-endpoint')
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
  check('xai: the Grok subscription and its token bytes are forgotten', !xai.xaiStoredTokens() && authFile('.xai-auth.json').tokens === undefined)
  check('moonshot: the Kimi sign-in is disconnected', moonshot.moonshotStoredTokens() === undefined)
  check('moonshot: the stored key is gone', secrets.readStoredMoonshotApiKey() === undefined)
  check('huggingface: the device-flow sign-in is disconnected', huggingface.huggingfaceStoredTokens() === undefined)
  check('huggingface: the stored token is gone', secrets.readStoredHuggingfaceApiKey() === undefined)
  check('deepseek: the stored key is gone', secrets.readStoredDeepseekApiKey() === undefined)
  check('compat: the stored key is gone', secrets.readStoredCompatApiKey() === undefined)
  check('logout removes named custom endpoint keys as well as the default (F43A-C6-01)', secrets.readStoredCompatApiKey('named') === undefined && authFile('.provider-secrets.json').compatEndpointKeys === undefined)
  check('local: the stored key is gone', secrets.readStoredLocalApiKey() === undefined)

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

section('§3 a family whose auth file cannot be read — it is named, the others are signed out, and the terminal verb exits 1')
if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
  console.log('  [SKIP] the refused family — a mode-0200 file needs a POSIX process that is not root')
} else {
  const { performLogout } = await import('../../src/commands/logout/logout.js')
  const hfPath = huggingface.huggingfaceAuthPathForDisplay()
  const held = JSON.stringify({ version: 1, tokens: { accessToken: 'hf-fixture-access', refreshToken: 'hf-fixture-refresh', accessTokenExpiresAtMs: far } }, null, 2) + '\n'
  const words = `Could not sign out: The Hugging Face auth file at ${hfPath} exists but could not be read (EACCES); nothing was written. Make it readable, or move it away to start a new one, then try again.`
  const seed = (): void => {
    secrets.writeStoredGeminiApiKey('fixture-gemini')
    moonshot.writeMoonshotTokens({ accessToken: 'kimi-fixture-access', refreshToken: 'kimi-fixture-refresh', accessTokenExpiresAtMs: far }, 'global')
    writeFileSync(hfPath, held, { mode: 0o600 })
    chmodSync(hfPath, 0o200)
  }
  const othersSignedOut = (): boolean => authFile('.provider-secrets.json').geminiApiKey === undefined && authFile('.moonshot-auth.json').tokens === undefined

  seed()
  const refused: unknown = await performLogout()
  chmodSync(hfPath, 0o600)
  check('performLogout answers the one family it could not sign out, in the sign-out\'s own sentence', JSON.stringify(refused) === JSON.stringify([words]), `answered ${JSON.stringify(refused)}`)
  check('that family\'s file stands byte for byte, and the other families are signed out', readFileSync(hfPath, 'utf8') === held && othersSignedOut())

  const OTHERS = 'The other providers are signed out.'
  const signOutByTheVerb = () => {
    const ran = spawnSync(process.execPath, ['-e', `
      globalThis.MACRO = { VERSION: '1.0.0' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/config.js'))})
      enableConfigs()
      const { authLogout } = await import(${JSON.stringify(join(import.meta.dir, '../../src/cli/handlers/auth.ts'))})
      await authLogout()
    `], { encoding: 'utf8', env: process.env })
    chmodSync(hfPath, 0o600)
    return ran
  }
  seed()
  const verb = signOutByTheVerb()
  check('mercury auth logout says it on the error stream, does not say Signed out, and exits 1', verb.status === 1 && verb.stderr.includes(words) && !verb.stdout.includes('Signed out'), `exit ${verb.status} · stdout ${JSON.stringify(verb.stdout.slice(-200))} · stderr ${JSON.stringify(verb.stderr.slice(-400))}`)
  check('…the file stands and the other families are signed out', readFileSync(hfPath, 'utf8') === held && othersSignedOut())
  check('…and, two other providers having been signed out by it, one line after the refusal says so', verb.stderr.includes(`${words}\n${OTHERS}\n`), `stderr ${JSON.stringify(verb.stderr.slice(-500))}`)
  chmodSync(hfPath, 0o200)
  const alone = signOutByTheVerb()
  check('with no other provider signed in, the refusal stands alone: nothing is said of others', alone.status === 1 && alone.stderr.includes(words) && !alone.stderr.includes(OTHERS) && !alone.stdout.includes('Signed out'), `exit ${alone.status} · stderr ${JSON.stringify(alone.stderr.slice(-500))}`)
  secrets.writeStoredHuggingfaceApiKey('hf_fixture_stored')
  chmodSync(hfPath, 0o200)
  const sameProvider = signOutByTheVerb()
  check('a stored token of the refused provider itself, signed out by the command, is not another provider', sameProvider.status === 1 && sameProvider.stderr.includes(words) && !sameProvider.stderr.includes(OTHERS) && secrets.readStoredHuggingfaceApiKey() === undefined, `exit ${sameProvider.status} · stderr ${JSON.stringify(sameProvider.stderr.slice(-500))}`)
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-logout-every-family — all checks pass' : `\n❌ prove-logout-every-family — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
