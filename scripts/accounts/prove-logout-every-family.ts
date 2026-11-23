#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let where = 'writeXaiTokens and xaiStoredTokens in src/models/roads/xai/xaiOauth.ts'
const WHERES: Record<string, string> = {
  '§1': 'the writer and reader named in the label: src/models/sign-in/account-ledger/providerSecrets.ts for stored keys, the family\'s *Accounts.ts under src/models/roads/ for sign-ins',
  '§2': 'performLogout in src/commands/logout/logout.tsx must empty the store named in the label',
  '§3': 'performLogout in src/commands/logout/logout.tsx, authLogout in src/commands/verbs/auth.ts and call in src/commands/logout/logout.tsx must name the refused store and end 1',
  '§4': 'providerAuthLogout in src/commands/verbs/providerAuth.ts and executeSlotRemoval in src/models/roads/account-slots/removal.ts must name the store they could not read or write',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail}; ` : ''}${where}` : ''}`)
}
function section(title: string): void {
  where = WHERES[title.slice(0, 2)] ?? where
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

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

const secrets = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
const openai = await import('../../src/models/roads/openai/openaiAccounts.js')
const openrouter = await import('../../src/models/roads/openrouter/openrouterAccounts.js')
const gemini = await import('../../src/models/roads/gemini/geminiAccounts.js')
const moonshot = await import('../../src/models/roads/moonshot/moonshotAccounts.js')
const huggingface = await import('../../src/models/roads/huggingface/huggingfaceAccounts.js')

const xai = await import('../../src/models/roads/xai/xaiOauth.js')
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
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/platform/settings/config.js'))})
      enableConfigs()
      const { authLogout } = await import(${JSON.stringify(join(import.meta.dir, '../../src/commands/verbs/auth.ts'))})
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
  seed()
  const command = spawnSync(process.execPath, ['-e', `
    globalThis.MACRO = { VERSION: '1.0.0' }
    const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/platform/settings/config.js'))})
    enableConfigs()
    const { call } = await import(${JSON.stringify(join(import.meta.dir, '../../src/commands/logout/logout.tsx'))})
    const shown = await call()
    process.stdout.write('SHOWN ' + JSON.stringify(shown.props.children) + '\\n')
  `], { encoding: 'utf8', env: process.env, timeout: 60_000 })
  chmodSync(hfPath, 0o600)
  check('the /logout command shows the refusal and the line about the others where it said "Logged out of all your accounts.", leaves both on the terminal as the session ends, and ends 1', command.status === 1 && command.stdout.includes(`SHOWN ${JSON.stringify(`${words}\n${OTHERS}`)}`) && command.stderr.includes(`${words}\n${OTHERS}\n`) && !command.stdout.includes('Logged out of all your accounts'), `exit ${command.status} · stdout ${JSON.stringify(command.stdout.slice(-500))} · stderr ${JSON.stringify(command.stderr.slice(-500))}`)
  chmodSync(hfPath, 0o200)
  const alone = signOutByTheVerb()
  check('with no other provider signed in, the refusal stands alone: nothing is said of others', alone.status === 1 && alone.stderr.includes(words) && !alone.stderr.includes(OTHERS) && !alone.stdout.includes('Signed out'), `exit ${alone.status} · stderr ${JSON.stringify(alone.stderr.slice(-500))}`)
  secrets.writeStoredHuggingfaceApiKey('hf_fixture_stored')
  chmodSync(hfPath, 0o200)
  const sameProvider = signOutByTheVerb()
  check('a stored token of the refused provider itself, signed out by the command, is not another provider', sameProvider.status === 1 && sameProvider.stderr.includes(words) && !sameProvider.stderr.includes(OTHERS) && secrets.readStoredHuggingfaceApiKey() === undefined, `exit ${sameProvider.status} · stderr ${JSON.stringify(sameProvider.stderr.slice(-500))}`)
  if (process.platform !== 'darwin') console.log('  [SKIP] the credential store that cannot be removed — a file that takes no unlink is made here with the immutable flag of macOS')
  else {
    const store = (await import('../../src/platform/secure-storage/index.js')).credentialsPath()
    const storeWords = `Could not sign out: ${store} could not be removed; the sign-ins it holds are still stored here. Close what holds the file, then try again.`
    writeFileSync(store, JSON.stringify({ mcpOAuth: { fixture: { accessToken: 'fixture-mcp-token' } } }), { mode: 0o600 })
    spawnSync('/usr/bin/chflags', ['uchg', store])
    const left: unknown = await performLogout()
    const byVerb = signOutByTheVerb()
    spawnSync('/usr/bin/chflags', ['nouchg', store])
    check('a credential store that cannot be removed is named by performLogout and by the terminal verb, which ends 1 and does not say Signed out; the store stands', JSON.stringify(left) === JSON.stringify([storeWords]) && byVerb.status === 1 && byVerb.stderr.includes(`${storeWords}\n`) && !byVerb.stdout.includes('Signed out') && existsSync(store), `answered ${JSON.stringify(left)} · exit ${byVerb.status} · stdout ${JSON.stringify(byVerb.stdout.slice(-200))} · stderr ${JSON.stringify(byVerb.stderr.slice(-500))}`)
    rmSync(store, { force: true })
  }
}

section('§4 the Claude login — a credential store that cannot be read or written is named by the sign-out of that provider and of its slot')
if (process.platform !== 'darwin' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
  console.log('  [SKIP] the Claude login — a file that takes no write is made here with the immutable flag of macOS')
} else {
  const store = (await import('../../src/platform/secure-storage/index.js')).credentialsPath()
  const CLAUDE = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-access', refreshToken: 'fixture-claude-refresh', expiresAt: far, scopes: ['user:inference'], subscriptionType: 'max' }, mcpOAuth: { other: { accessToken: 'fixture-mcp-token' } } })
  const signOutClaude = (how: 'unreadable' | 'immutable'): { said: { out: string; err: string; exit: number | null }; slot: { note?: string; mutated?: boolean; refused?: boolean; threw?: string }; same: boolean } => {
    writeFileSync(store, CLAUDE, { mode: 0o600 })
    if (how === 'unreadable') chmodSync(store, 0o200)
    else spawnSync('/usr/bin/chflags', ['uchg', store])
    const ran = spawnSync(process.execPath, ['-e', `
      globalThis.MACRO = { VERSION: '1.0.0' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/platform/settings/config.js'))})
      enableConfigs()
      const cli = await import(${JSON.stringify(join(import.meta.dir, '../../src/commands/verbs/providerAuth.ts'))})
      const removal = await import(${JSON.stringify(join(import.meta.dir, '../../src/models/roads/account-slots/removal.ts'))})
      const said = { out: '', err: '', exit: null }
      await cli.providerAuthLogout('anthropic', { writeOut: text => { said.out += text }, writeErr: text => { said.err += text }, exit: code => { said.exit = code } })
      let slot
      try {
        slot = removal.executeSlotRemoval({ id: 'anthropic:oauth', family: 'anthropic', kind: 'oauth', signedIn: true, removal: { route: 'anthropic-oauth', dir: process.env.MERCURY_CONFIG_DIR } }, { revokeAnthropicToken: async () => {} })
      } catch (error) {
        slot = { threw: String(error.message ?? error) }
      }
      process.stdout.write('\\n' + JSON.stringify({ said, slot }))
      process.exit(0)
    `], { encoding: 'utf8', env: { ...process.env, MERCURY_ANTHROPIC_OAUTH_BASE: dead }, timeout: 60_000 })
    if (how === 'unreadable') chmodSync(store, 0o600)
    else spawnSync('/usr/bin/chflags', ['nouchg', store])
    const answered = JSON.parse(ran.stdout.trim().split('\n').pop() || '{}') as { said?: { out: string; err: string; exit: number | null }; slot?: { note?: string; mutated?: boolean; refused?: boolean; threw?: string } }
    return { said: answered.said ?? { out: ran.stdout, err: ran.stderr, exit: ran.status }, slot: answered.slot ?? {}, same: readFileSync(store, 'utf8') === CLAUDE }
  }
  for (const [how, words] of [
    ['unreadable', `Could not sign out: The credential store at ${store} exists but could not be read (EACCES); nothing was written.`],
    ['immutable', `Could not sign out: ${store} could not be written (EPERM); nothing was written. Close what holds the file, then try again.`],
  ] as const) {
    const ran = signOutClaude(how)
    check(`${how}: mercury auth logout anthropic names the store on the error stream and ends 1`, ran.said.err === `${words}\n` && ran.said.out === '' && ran.said.exit === 1, JSON.stringify(ran.said))
    check(`${how}: the sign-out of the Claude slot answers the same note, refused, and the store stands byte for byte with its login`, ran.slot.note === words && ran.slot.refused === true && ran.slot.mutated === false && ran.same, `${JSON.stringify(ran.slot)} · store ${ran.same ? 'kept' : 'changed'}`)
  }
  rmSync(store, { force: true })

  const ONLY = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-access', refreshToken: 'fixture-claude-refresh', expiresAt: far, scopes: ['user:inference'], subscriptionType: 'max' } })
  const bin = join(scratch, 'keychain-bin')
  mkdirSync(bin, { recursive: true })
  const signOutOnKeychainStorage = (keychain: 'holds nothing' | 'is locked', file: 'immutable' | 'free'): { said: { out: string; err: string; exit: number | null }; stands: boolean } => {
    writeFileSync(join(bin, 'security'), `#!/bin/sh\nif [ "$1" = "-i" ]; then cat >/dev/null; fi\nif [ "$1" = "delete-generic-password" ] && [ ${keychain === 'is locked' ? 1 : 0} = 1 ]; then exit 36; fi\nexit 44\n`)
    chmodSync(join(bin, 'security'), 0o755)
    writeFileSync(store, ONLY, { mode: 0o600 })
    if (file === 'immutable') spawnSync('/usr/bin/chflags', ['uchg', store])
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, MERCURY_ANTHROPIC_OAUTH_BASE: dead }
    delete env.MERCURY_CREDENTIAL_STORE
    const ran = spawnSync(process.execPath, ['-e', `
      globalThis.MACRO = { VERSION: '1.0.0' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/platform/settings/config.js'))})
      enableConfigs()
      const cli = await import(${JSON.stringify(join(import.meta.dir, '../../src/commands/verbs/providerAuth.ts'))})
      const said = { out: '', err: '', exit: null }
      await cli.providerAuthLogout('anthropic', { writeOut: text => { said.out += text }, writeErr: text => { said.err += text }, exit: code => { said.exit = code } })
      process.stdout.write('\\n' + JSON.stringify({ said }))
      process.exit(0)
    `], { encoding: 'utf8', env, timeout: 60_000 })
    if (file === 'immutable') spawnSync('/usr/bin/chflags', ['nouchg', store])
    const answered = JSON.parse(ran.stdout.trim().split('\n').pop() || '{}') as { said?: { out: string; err: string; exit: number | null } }
    const stands = existsSync(store) && readFileSync(store, 'utf8') === ONLY
    rmSync(store, { force: true })
    return { said: answered.said ?? { out: ran.stdout, err: ran.stderr, exit: ran.status }, stands }
  }
  const fileLeft = signOutOnKeychainStorage('holds nothing', 'immutable')
  check('a Mac as it comes, the login alone in a credential file that cannot be removed: the sign-out names the file, ends 1, and the login stands', fileLeft.said.err === `Could not sign out: ${store} could not be removed; the sign-ins it holds are still stored here. Close what holds the file, then try again.\n` && fileLeft.said.out === '' && fileLeft.said.exit === 1 && fileLeft.stands, `${JSON.stringify(fileLeft.said)} · file ${fileLeft.stands ? 'kept' : 'changed'}`)
  const keychainLeft = signOutOnKeychainStorage('is locked', 'free')
  check('a Mac as it comes, a keychain that refuses the removal: the sign-out names the keychain and ends 1', keychainLeft.said.err === 'Could not sign out: The keychain entry of Mercury could not be removed; the sign-ins it holds are still stored here. Unlock the keychain, then try again.\n' && keychainLeft.said.out === '' && keychainLeft.said.exit === 1, JSON.stringify(keychainLeft.said))
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-logout-every-family — all checks pass' : `\n❌ prove-logout-every-family — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
