#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'identity-words-home-'))
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.OPENAI_API_KEY
delete process.env.ANTHROPIC_API_KEY

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const usage = await import('../../src/models/roads/providerUsage.ts')
const accounts = await import('../../src/models/roads/openai/openaiAccounts.ts')
const wallet = await import('../../src/models/wallet/wallet.ts')
type Presence = import('../../src/models/roads/providerUsage.ts').ProviderFamilyPresence
type Providers = Parameters<typeof usage.providerFamilyPresences>[0]

const EMAIL = 'gpt-operator@example.com'
const CLAUDE_EMAIL = 'claude-operator@example.com'

section('I2 the ONE composer — identity over the label, label as the fallback, nothing when absent')
{
  const words = usage.presenceIdentityWords
  check('a recorded identity wins over the plan label', words({ credentialed: true, credentialLabel: 'ChatGPT prolite subscription', identity: EMAIL }) === EMAIL, 'change presenceIdentityWords in src/models/roads/providerUsage.ts to return the recorded identity first')
  check('no recorded identity ⇒ the truthful label (never blank)', words({ credentialed: true, credentialLabel: 'OpenAI API key (env)' }) === 'OpenAI API key (env)', 'change presenceIdentityWords in src/models/roads/providerUsage.ts to fall back to credentialLabel when identity is absent')
  check('nothing present ⇒ undefined, whatever the fields say', words({ credentialed: false, credentialLabel: 'stale', identity: 'stale@example.com' }) === undefined, 'change presenceIdentityWords in src/models/roads/providerUsage.ts to return undefined when credentialed is false')
}

section('I1 the presence owner exposes identity per family from the OWNING store')
{
  const providers = [
    { id: 'anthropic', available: true, description: { account: { kind: 'inherited-main', label: 'main' } } },
    { id: 'openai', available: true, description: { account: { kind: 'chatgpt-login', label: 'ChatGPT prolite subscription' } } },
    { id: 'huggingface', available: true, description: { account: { kind: 'provider-oauth', label: 'Hugging Face account (OAuth device flow)' } } },
    { id: 'zai', available: false, reason: 'no-key:zai', description: { account: { kind: 'none', label: 'no Z.AI API key' } } },
  ] as unknown as Providers
  const presences = usage.providerFamilyPresences(providers, {
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'claude.ai', hasToken: true }),
    anthropicEmail: () => CLAUDE_EMAIL,
    engineIdentity: id => (id === 'openai' ? EMAIL : id === 'huggingface' ? 'hub-operator' : undefined),
  })
  const by = (id: string): Presence | undefined => presences.find(p => (p.id as string) === id)
  check('anthropic: the subscription seat exposes the account email as identity, the plan label beside it', by('anthropic')?.identity === CLAUDE_EMAIL && by('anthropic')?.credentialLabel === 'Claude subscription (max)', JSON.stringify(by('anthropic')) + ' — change the anthropic row in providerFamilyPresences (src/models/roads/providerUsage.ts) to set identity from anthropicEmail and the plan label from the subscription type')
  check('openai: the ChatGPT sign-in exposes its recorded email; the label is untouched', by('openai')?.identity === EMAIL && by('openai')?.credentialLabel === 'ChatGPT prolite subscription', JSON.stringify(by('openai')) + ' — change the engine rows in providerFamilyPresences (src/models/roads/providerUsage.ts) to set identity from engineIdentity and keep the provider description label')
  check('huggingface: the Hub username is the identity', by('huggingface')?.identity === 'hub-operator', JSON.stringify(by('huggingface')) + ' — change the engine rows in providerFamilyPresences (src/models/roads/providerUsage.ts) to take identity from engineIdentity')
  check('an absent family exposes neither label nor identity', by('zai')?.credentialed === false && by('zai')?.identity === undefined && by('zai')?.credentialLabel === undefined, JSON.stringify(by('zai')) + ' — change providerFamilyPresences (src/models/roads/providerUsage.ts) so an unavailable family carries no label and no identity')
  check('the composer reads the same rows: email for ChatGPT and Claude alike', usage.presenceIdentityWords(by('openai')!) === EMAIL && usage.presenceIdentityWords(by('anthropic')!) === CLAUDE_EMAIL, 'change presenceIdentityWords or the identity fields of providerFamilyPresences in src/models/roads/providerUsage.ts so both rows give the email')

  const keyOnly = usage.providerFamilyPresences(providers, {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => true,
    bearerTokenSource: () => ({ source: 'none', hasToken: false }),
    anthropicEmail: () => CLAUDE_EMAIL,
    engineIdentity: () => undefined,
  })
  const keyRow = keyOnly.find(p => (p.id as string) === 'anthropic')
  check('anthropic on a key: no identity (a stale account snapshot never rides a key), the key label stands', keyRow?.identity === undefined && keyRow?.credentialLabel === 'Anthropic API key', JSON.stringify(keyRow) + ' — change the anthropic row in providerFamilyPresences (src/models/roads/providerUsage.ts) to leave identity unset when the credential is an API key')
  const engineNone = keyOnly.find(p => (p.id as string) === 'openai')
  check('an engine family whose store records no identity exposes none — the label is its identity words', engineNone?.identity === undefined && usage.presenceIdentityWords(engineNone!) === 'ChatGPT prolite subscription', JSON.stringify(engineNone) + ' — change providerFamilyPresences or presenceIdentityWords in src/models/roads/providerUsage.ts so an engine row without a recorded identity leaves identity unset and uses its label')
  const blank = usage.providerFamilyPresences(providers, {
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'claude.ai', hasToken: true }),
    anthropicEmail: () => '   ',
    engineIdentity: () => '',
  })
  check('a blank identity spelling reads as absent (never a blank row)', blank.every(p => p.identity === undefined), JSON.stringify(blank.map(p => p.identity)) + ' — change providerFamilyPresences in src/models/roads/providerUsage.ts to trim identity spellings and treat blank as absent')
}

section('I4 the live stores: the ChatGPT sign-in on disk feeds the presence identity AND the wallet entry')
{
  const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const fakeJwt = (payload: Record<string, unknown>): string =>
    `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.${b64url('sig')}`
  const path = accounts.openaiAuthPathForDisplay()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: fakeJwt({ email: EMAIL }),
        accessToken: 'at_1',
        refreshToken: 'rt_1',
        accountId: 'acct_1',
        planType: 'prolite',
        email: EMAIL,
      },
    }) + '\n',
  )
  const live = usage.providerFamilyPresences()
  const openai = live.find(p => (p.id as string) === 'openai')
  check('the live presence owner reads the stored email as the ChatGPT identity', openai?.credentialed === true && openai?.identity === EMAIL, JSON.stringify(openai) + ' — change providerFamilyPresences (src/models/roads/providerUsage.ts) so the live engineIdentity reads the email stored in the ChatGPT auth file')
  check('…beside the plan label the other surfaces pin', openai?.credentialLabel === 'ChatGPT prolite subscription', JSON.stringify(openai?.credentialLabel) + ' — change the openai row in providerFamilyPresences (src/models/roads/providerUsage.ts) to keep the plan label beside the identity')
  check('the composer answers the email for the live row', openai !== undefined && usage.presenceIdentityWords(openai) === EMAIL, 'change presenceIdentityWords in src/models/roads/providerUsage.ts to return the identity of the live row')
  const entry = wallet.walletEntries().find(e => e.provider === 'openai' && e.kind === 'subscription-oauth')
  check('the wallet\'s ChatGPT entry carries the email in its identity (the /status continuation fact)', entry?.identity?.email === EMAIL && entry?.identity?.plan === 'prolite', JSON.stringify(entry?.identity) + ' — change walletEntries in src/models/wallet/wallet.ts so the ChatGPT subscription entry carries the stored email and plan')
}


console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('IDENTITY WORDS: ALL GREEN')
else console.log(`❌ ${failures} IDENTITY LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
