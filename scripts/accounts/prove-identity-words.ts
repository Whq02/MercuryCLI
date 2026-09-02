#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-identity-words.ts — the identity words every
//  account surface prints come from ONE composer over the ONE presence owner
//  (the operator sighting: the Boot face's account chip showed the email for
//  the Claude sign-in but "ChatGPT prolite subscript…" for the ChatGPT
//  sign-in, whose token store had recorded the email all along).
//
//  ROOT CAUSE: the presence owner (providerFamilyPresences) exposed a plan/
//  source LABEL per family and no identity; the chip painted the Anthropic
//  snapshot's email on the anthropic route and the label for every other
//  family — a per-surface copy of "the identity words", structurally never
//  an identity off the Anthropic route.
//
//  THE LAWS:
//    I1  the presence owner exposes `identity` per family from the family's
//        OWNING store (the ChatGPT sign-in's email, the Anthropic account
//        snapshot's email, the Hub username); a credential that records
//        none (a key, a local server) exposes no identity — never invented;
//    I2  presenceIdentityWords is the ONE composer: identity when recorded,
//        else the credential's label, undefined when nothing is present;
//    I3  every identity surface reads the composer — the boot chip, /status
//        (both builders), the /accounts board's main-loop row, the
//        /defaultprovider picker, the headless auth verb (structural);
//    I4  the wallet's ChatGPT entry carries the email (the /status
//        continuation row's fact) — behavioural over the real store.
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-identity-words.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const usage = await import('../../src/services/providers/providerUsage.ts')
const accounts = await import('../../src/services/providers/openai/openaiAccounts.ts')
const wallet = await import('../../src/services/wallet/wallet.ts')
type Presence = import('../../src/services/providers/providerUsage.ts').ProviderFamilyPresence
type Providers = Parameters<typeof usage.providerFamilyPresences>[0]

const EMAIL = 'gpt-operator@example.com'
const CLAUDE_EMAIL = 'claude-operator@example.com'

section('I2 the ONE composer — identity over the label, label as the fallback, nothing when absent')
{
  const words = usage.presenceIdentityWords
  check('a recorded identity wins over the plan label', words({ credentialed: true, credentialLabel: 'ChatGPT prolite subscription', identity: EMAIL }) === EMAIL)
  check('no recorded identity ⇒ the truthful label (never blank)', words({ credentialed: true, credentialLabel: 'OpenAI API key (env)' }) === 'OpenAI API key (env)')
  check('nothing present ⇒ undefined, whatever the fields say', words({ credentialed: false, credentialLabel: 'stale', identity: 'stale@example.com' }) === undefined)
}

section('I1 the presence owner exposes identity per family from the OWNING store')
{
  // A fixture registry: three families, the engine adapters' account views
  // as the registry hands them (kind + label, no identity — the owner asks
  // the family's own store for that).
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
  check('anthropic: the subscription seat exposes the account email as identity, the plan label beside it', by('anthropic')?.identity === CLAUDE_EMAIL && by('anthropic')?.credentialLabel === 'Claude subscription (max)', JSON.stringify(by('anthropic')))
  check('openai: the ChatGPT sign-in exposes its recorded email; the label is untouched', by('openai')?.identity === EMAIL && by('openai')?.credentialLabel === 'ChatGPT prolite subscription', JSON.stringify(by('openai')))
  check('huggingface: the Hub username is the identity', by('huggingface')?.identity === 'hub-operator')
  check('an absent family exposes neither label nor identity', by('zai')?.credentialed === false && by('zai')?.identity === undefined && by('zai')?.credentialLabel === undefined)
  check('the composer reads the same rows: email for ChatGPT and Claude alike', usage.presenceIdentityWords(by('openai')!) === EMAIL && usage.presenceIdentityWords(by('anthropic')!) === CLAUDE_EMAIL)

  // A key on the Anthropic family names no account: the label is honest.
  const keyOnly = usage.providerFamilyPresences(providers, {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => true,
    bearerTokenSource: () => ({ source: 'none', hasToken: false }),
    anthropicEmail: () => CLAUDE_EMAIL, // a stale snapshot must NOT ride a key
    engineIdentity: () => undefined,
  })
  const keyRow = keyOnly.find(p => (p.id as string) === 'anthropic')
  check('anthropic on a key: no identity (a stale account snapshot never rides a key), the key label stands', keyRow?.identity === undefined && keyRow?.credentialLabel === 'Anthropic API key')
  const engineNone = keyOnly.find(p => (p.id as string) === 'openai')
  check('an engine family whose store records no identity exposes none — the label is its identity words', engineNone?.identity === undefined && usage.presenceIdentityWords(engineNone!) === 'ChatGPT prolite subscription')
  const blank = usage.providerFamilyPresences(providers, {
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
    bearerTokenSource: () => ({ source: 'claude.ai', hasToken: true }),
    anthropicEmail: () => '   ',
    engineIdentity: () => '',
  })
  check('a blank identity spelling reads as absent (never a blank row)', blank.every(p => p.identity === undefined))
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
  check('the live presence owner reads the stored email as the ChatGPT identity', openai?.credentialed === true && openai?.identity === EMAIL, JSON.stringify(openai))
  check('…beside the plan label the other surfaces pin', openai?.credentialLabel === 'ChatGPT prolite subscription', JSON.stringify(openai?.credentialLabel))
  check('the composer answers the email for the live row', openai !== undefined && usage.presenceIdentityWords(openai) === EMAIL)
  const entry = wallet.walletEntries().find(e => e.provider === 'openai' && e.kind === 'subscription-oauth')
  check('the wallet\'s ChatGPT entry carries the email in its identity (the /status continuation fact)', entry?.identity?.email === EMAIL && entry?.identity?.plan === 'prolite', JSON.stringify(entry?.identity))
}

section('I3 every identity surface reads the ONE composer (structural)')
{
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  const chip = read('src/components/BootSplashScreen.tsx')
  const chipBlock = chip.slice(chip.indexOf('const chips = useMemo('), chip.indexOf('const selectedIndex = selCleared'))
  check('the boot chip block reads the composer', chipBlock.includes('presenceIdentityWords(presence)'))
  check('…and no longer keeps its own Anthropic-only email copy', !chipBlock.includes('emailAddress') && !chipBlock.includes("startsWith('Claude subscription')"))
  check('…for every family alike (one presence, one composer — no per-route branches of words)', !chipBlock.includes("presence.credentialLabel ?? 'signed in'"))
  check('…re-deriving on the sign-in epoch', chipBlock.includes('signInEpoch]') && chip.includes("import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js'"))
  const status = read('src/utils/status.tsx')
  check('/status blocks print the composer\'s words on the family row', status.includes('presenceIdentityWords(family)'))
  check('…and carry the label as the continuation when the identity took the row (both facts, neither twice)', status.includes("via · {family.credentialLabel}"))
  const facts = read('src/commands/status/mercuryStatus.tsx')
  check('the /status command facts read the composer', facts.includes('presenceIdentityWords(family)'))
  const board = read('src/services/providers/accountSlots.ts')
  check('the /accounts board\'s main-loop row reads the composer for every engine family', board.includes('presenceIdentityWords(presence) ?? label'))
  const picker = read('src/commands/defaultprovider/defaultprovider.tsx')
  check('the /defaultprovider picker reads the composer', picker.includes("presenceIdentityWords(presence) ?? 'signed in'"))
  const verb = read('src/cli/handlers/auth.ts')
  check('the headless auth verb carries the presence identity on its rows (additive) and prints it in --text', verb.includes('identity?: string') && verb.includes('row.identity ?? row.source'))
  check('…and a ChatGPT-only operator is no longer told "Not signed in"', verb.includes('No Anthropic credential —'))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('IDENTITY WORDS: ALL GREEN')
else console.log(`❌ ${failures} IDENTITY LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
