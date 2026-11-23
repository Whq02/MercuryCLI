#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' PROVAUTH — the OpenAI subscription catalogue follows the account, not the token')
console.log('============================================================')

for (const key of ['OPENAI_API_KEY', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_HOME', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-openai-catalogue-account-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

const home = process.env.MERCURY_CONFIG_DIR
const authFile = join(home, '.openai-auth.json')
type SignIn = { tail: string; accountId?: string }
function landSignIn(signIn: SignIn): void {
  const now = Date.now()
  writeFileSync(
    authFile,
    JSON.stringify(
      {
        version: 1,
        tokens: {
          idToken: `fixture-id-${signIn.tail}`,
          accessToken: `fixture-access-${signIn.tail}`,
          refreshToken: `fixture-refresh-${signIn.tail}`,
          ...(signIn.accountId !== undefined ? { accountId: signIn.accountId } : {}),
          planType: 'pro',
          email: 'owner@example.test',
          accessTokenExpiresAtMs: now + 86_400_000,
        },
        lastRefreshMs: now,
        preferredSource: 'chatgpt-subscription',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
}

const ASTRA_ROW = { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'medium', visibility: 'list', priority: 1, context_window: 400_000 }
const modelsCalls: Array<{ bearer: string }> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
  const u = String(url)
  if (u.includes('/models')) {
    modelsCalls.push({ bearer: init?.headers?.authorization ?? init?.headers?.Authorization ?? '' })
    return new Response(JSON.stringify({ models: [ASTRA_ROW] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected fixture URL: ${u}`)
}) as unknown as typeof fetch

const accounts = await import('../../src/models/roads/openai/openaiAccounts.ts')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.ts')
const effort = await import('../../src/models/effort/effort.ts')
const { effortSentOf } = await import('../../src/engine/connector/seatProjections.ts')
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

section('§1 the identity is the account when the sign-in names one')
{
  landSignIn({ tail: 'a1', accountId: 'acct-owner' })
  const first = accounts.openaiSourceIdentity('chatgpt-subscription')
  landSignIn({ tail: 'a2', accountId: 'acct-owner' })
  const relogged = accounts.openaiSourceIdentity('chatgpt-subscription')
  check('a re-login to the same account (every token new) keeps the identity', first === relogged, `${first} → ${relogged}; openaiSourceIdentity in src/models/roads/openai/openaiAccounts.ts must key on the account id when the sign-in has one`)
  landSignIn({ tail: 'a3', accountId: 'acct-owner' })
  check('a refresh-token rotation keeps it too', accounts.openaiSourceIdentity('chatgpt-subscription') === first, 'openaiSourceIdentity in src/models/roads/openai/openaiAccounts.ts must not depend on the refresh token when an account id is present')
  landSignIn({ tail: 'b1', accountId: 'acct-other' })
  check('another account is another identity', accounts.openaiSourceIdentity('chatgpt-subscription') !== first, 'openaiSourceIdentity in src/models/roads/openai/openaiAccounts.ts must return a different identity for a different account id')
  landSignIn({ tail: 'c1' })
  const idLess = accounts.openaiSourceIdentity('chatgpt-subscription')
  landSignIn({ tail: 'c2' })
  check('a sign-in without an account id keys on its refresh token (a new token is a new identity)', idLess !== 'none' && accounts.openaiSourceIdentity('chatgpt-subscription') !== idLess, 'openaiSourceIdentity in src/models/roads/openai/openaiAccounts.ts must fall back to the refresh token when the sign-in carries no account id')
}

section('§2 a served catalogue outlives a same-account re-login: max stays max, nothing is dropped or refetched')
{
  catalogue.__resetOpenaiCatalogueForTest()
  landSignIn({ tail: 'a1', accountId: 'acct-owner' })
  const served = await catalogue.refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  check('the account A sign-in fetches its list once (bearer a1)', modelsCalls.length === 1 && modelsCalls[0]?.bearer === 'Bearer fixture-access-a1' && served?.models.length === 1, `calls ${JSON.stringify(modelsCalls)}; refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must fetch /models once under the signed-in access token`)
  catalogue.readOpenaiAccountAgain()
  await tick()
  const before = effort.resolveEffortTruth('gpt-6-astra', 'max')
  check("the session resolves max on Astra (gpt-live) and the facts read 'max'", before.catalogue === 'gpt-live' && before.wire === 'max' && effortSentOf(before) === 'max', JSON.stringify({ catalogue: before.catalogue, wire: before.wire }) + '; resolveEffortTruth in src/models/effort/effort.ts must read the served live catalogue (liveGptEffortCatalogue in openaiCatalogue.ts)')

  landSignIn({ tail: 'a2', accountId: 'acct-owner' })
  check('after the re-login the cached catalogue still serves under the current credential', catalogue.getCachedOpenaiCatalogue('chatgpt-subscription') !== null, 'getCachedOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must keep serving the snapshot when the same account signs in again')
  check("the live effort catalogue for Astra still carries max", catalogue.liveGptEffortCatalogue('gpt-6-astra')?.vocabulary.includes('max') === true, 'liveGptEffortCatalogue in src/models/roads/openai/openaiCatalogue.ts must still read the served rows after a same-account re-login')
  const after = effort.resolveEffortTruth('gpt-6-astra', 'max')
  check("the resolver still reads gpt-live / max and the facts read 'max' (never null)", after.catalogue === 'gpt-live' && after.wire === 'max' && effortSentOf(after) === 'max', JSON.stringify({ catalogue: after.catalogue, wire: after.wire, sent: effortSentOf(after) }) + '; resolveEffortTruth in src/models/effort/effort.ts must not lose the served catalogue on a same-account re-login')
  const evaluated = catalogue.evaluateGptCandidate('gpt-6-astra', 'chatgpt-subscription')
  check('the dispatch qualification still finds the row with max served', evaluated.ok && evaluated.candidate.live.supportedReasoningEfforts.includes('max'), JSON.stringify(evaluated) + '; evaluateGptCandidate in src/models/roads/openai/openaiCatalogue.ts must still find the Astra row after a same-account re-login')
  const again = catalogue.readOpenaiAccountAgain()
  await tick()
  check('the credentials-changed road forgets nothing and drops nothing', again.forgotten.length === 0 && again.dropped === 0, JSON.stringify(again) + '; readOpenaiAccountAgain in src/models/roads/openai/openaiCatalogue.ts must compare identities and forget nothing for the same account')
  check('no second list fetch was made for the same account', modelsCalls.length === 1, `${modelsCalls.length} fetches; a same-account re-login must not trigger a second /models fetch (src/models/roads/openai/openaiCatalogue.ts)`)

  landSignIn({ tail: 'a3', accountId: 'acct-owner' })
  const rotated = effort.resolveEffortTruth('gpt-6-astra', 'max')
  check("a token rotation under the session leaves max on the wire", rotated.wire === 'max' && effortSentOf(rotated) === 'max', 'resolveEffortTruth in src/models/effort/effort.ts must keep max on the wire after a token rotation')
}

section('§3 another account is a new catalogue (unchanged): nothing cached, its own list fetched under its own bearer')
{
  landSignIn({ tail: 'b1', accountId: 'acct-other' })
  check('account B sees no cached snapshot of its own', catalogue.getCachedOpenaiCatalogue('chatgpt-subscription') === null, "getCachedOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must not serve another account's snapshot")
  const again = catalogue.readOpenaiAccountAgain()
  await tick()
  check("the credentials-changed road forgets the departed account and drops its rows", again.forgotten.includes('chatgpt-subscription') && again.dropped === 1, JSON.stringify(again) + '; readOpenaiAccountAgain in src/models/roads/openai/openaiCatalogue.ts must forget the departed account and drop its rows')
  const fresh = await catalogue.refreshOpenaiCatalogue('chatgpt-subscription')
  check('account B fetched its list under its own bearer', modelsCalls.length >= 2 && modelsCalls.at(-1)?.bearer === 'Bearer fixture-access-b1' && fresh?.models.length === 1, JSON.stringify(modelsCalls) + "; refreshOpenaiCatalogue in src/models/roads/openai/openaiCatalogue.ts must fetch under the new account's access token")
}

globalThis.fetch = realFetch
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
