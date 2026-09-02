#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-openai-identity.ts — the ChatGPT row
//  shows WHO is signed in (the operator sighting: the Claude login shows its
//  account email, the ChatGPT login never does).
//
//  ROOT CAUSE (adjudicated from the source): a MISSING-DATA-
//  AT-AUTH-TIME defect, not a display bug. The OAuth request asks for
//  'openid profile email', and the id_token comes back carrying the standard
//  top-level OIDC claims — but Mercury's own decode read ONLY the
//  proprietary nested claim (chatgpt_account_id / chatgpt_plan_type) and
//  OpenaiStoredTokens had no field that could even hold an email. Every UI
//  string downstream was a plan/source LABEL, structurally never an
//  identity. Anthropic's row shows an email because its token exchange
//  persists one into a typed AccountInfo; this closes the gap at the same
//  honest layer — capture at the ONE decode both the code exchange and the
//  refresh ride (a refresh without a fresh id_token keeps the old one, so
//  the email survives rotation), store it additively in the versioned auth
//  file (unknown-keys-preserved law), and surface it through the ONE slot
//  derivation every board reads (/accounts and the Boot Logins card both
//  paint AccountSlot.identity).
//
//  THE LAWS:
//    O1  the decode captures the top-level email claim; a token without one
//        yields NO email field (absence honest, never invented);
//    O2  the stored ref carries the email beside the untouched label (the
//        label's wording is pinned by other surfaces — receipts, /status);
//    O3  the slot derivation: identity = the email when present; the
//        truthful plan/key label when the provider yielded none — NEVER
//        blank; the plan survives in the kind label;
//    O4  every board reads the ONE derivation (AccountView and the Boot
//        Logins card consume AccountSlot.identity — structural).
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-openai-identity.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openai-id-home-'))

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const accounts = await import('../../src/services/providers/openai/openaiAccounts.ts')
const slots = await import('../../src/services/providers/accountSlots.ts')

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
const fakeJwt = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.${b64url('sig')}`

const EMAIL = 'gpt-operator@example.com'
const idTokenWithEmail = fakeJwt({
  email: EMAIL,
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' },
})
const idTokenNoEmail = fakeJwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' },
})

section('O1 the decode captures the standard email claim')
{
  const decode = (accounts as { tokensFromExchange?: (raw: { id_token: string; access_token: string; refresh_token: string }) => Record<string, unknown> }).tokensFromExchange
  check('the exchange decode is reachable for proof', typeof decode === 'function')
  if (typeof decode === 'function') {
    const tokens = decode({ id_token: idTokenWithEmail, access_token: fakeJwt({ exp: 2000000000 }), refresh_token: 'rt_1' })
    check('the top-level email claim is captured', tokens.email === EMAIL, JSON.stringify(tokens.email))
    check('the proprietary nested claims still decode beside it', tokens.accountId === 'acct_1' && tokens.planType === 'plus')
    const bare = decode({ id_token: idTokenNoEmail, access_token: fakeJwt({ exp: 2000000000 }), refresh_token: 'rt_1' })
    check('a token without an email yields NO email field (absence honest)', !('email' in bare), JSON.stringify(bare.email))
  }
}

section('O2 the stored ref carries the email beside the untouched label')
{
  // Write the auth file the way the store does (versioned, unknown keys
  // preserved) and read the ref back through the real door.
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const path = accounts.openaiAuthPathForDisplay()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: idTokenWithEmail,
        accessToken: 'at_1',
        refreshToken: 'rt_1',
        accountId: 'acct_1',
        planType: 'plus',
        email: EMAIL,
      },
    }) + '\n',
  )
  const ref = accounts.openaiSubscriptionRef()
  check('the subscription ref stands', ref !== undefined)
  check('…and carries the email', (ref as { email?: string } | undefined)?.email === EMAIL, JSON.stringify(ref))
  check('…and the label wording is untouched (other surfaces pin it)', ref?.label === 'ChatGPT plus subscription', JSON.stringify(ref?.label))
  const active = accounts.resolveOpenaiAccount({} as never)
  check('the active-account resolution carries it too', (active as { email?: string } | undefined)?.email === EMAIL, JSON.stringify(active))
}

section('O3 the slot derivation: email as identity, truthful label as the fallback')
{
  const withEmail = slots.deriveFamilySlotGroups(undefined, {
    openaiSubscription: () => ({ provider: 'openai', kind: 'chatgpt-subscription', label: 'ChatGPT plus subscription', planType: 'plus', email: EMAIL }),
    openaiActiveAccount: () => ({ provider: 'openai', kind: 'chatgpt-subscription', label: 'ChatGPT plus subscription', planType: 'plus', email: EMAIL }),
    openaiApiKey: () => undefined,
  } as never)
  const chatgpt = withEmail.flatMap(g => g.slots).find(s => s.id === 'openai:subscription')
  check('the ChatGPT slot shows the EMAIL as its identity', chatgpt?.identity === EMAIL, JSON.stringify(chatgpt?.identity))
  check('the plan survives in the kind label', chatgpt !== undefined && /plus/.test(chatgpt.kindLabel), JSON.stringify(chatgpt?.kindLabel))

  const withoutEmail = slots.deriveFamilySlotGroups(undefined, {
    openaiSubscription: () => ({ provider: 'openai', kind: 'chatgpt-subscription', label: 'ChatGPT plus subscription', planType: 'plus' }),
    openaiActiveAccount: () => ({ provider: 'openai', kind: 'chatgpt-subscription', label: 'ChatGPT plus subscription', planType: 'plus' }),
    openaiApiKey: () => undefined,
  } as never)
  const bare = withoutEmail.flatMap(g => g.slots).find(s => s.id === 'openai:subscription')
  check(
    'no email from the provider ⇒ the truthful account label, NEVER blank',
    bare?.identity === 'ChatGPT plus subscription' && bare.identity.length > 0,
    JSON.stringify(bare?.identity),
  )
}

section('O4 every board reads the ONE derivation')
{
  const view = readFileSync(join(ROOT, 'src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  const logins = readFileSync(join(ROOT, 'src/components/BootLoginsScreen.tsx'), 'utf8')
  check('/accounts paints AccountSlot.identity', view.includes('.identity'))
  check('the Boot Logins card paints AccountSlot.identity', logins.includes('.identity'))
}

console.log(
  failures === 0
    ? '\n ✅ OPENAI IDENTITY — the ChatGPT row says who, or says truthfully what'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
