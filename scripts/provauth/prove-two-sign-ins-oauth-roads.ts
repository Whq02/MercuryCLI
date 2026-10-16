#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'OPENAI_API_KEY', 'HF_TOKEN', 'MERCURY_USAGE_SEED']) delete process.env[key]
const HOME = mkdtempSync(join(tmpdir(), 'prove-two-sign-ins-oauth-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const bytes = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '<absent>')
const tokensOf = (path: string): Record<string, unknown> => (json(path).tokens ?? {}) as Record<string, unknown>
const within = <T>(promise: Promise<T>, ms = 8000): Promise<T | 'timed-out'> =>
  Promise.race([promise, new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), ms))])
const b64 = (payload: Record<string, unknown>): string => Buffer.from(JSON.stringify(payload)).toString('base64url')
const FUTURE_S = Math.floor(Date.now() / 1000) + 3600
const PAST_S = Math.floor(Date.now() / 1000) - 60
const idToken = (email: string, account: string): string => `h.${b64({ email, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } })}.s`
const accessJwt = (exp: number, who: string): string => `h.${b64({ exp, who })}.s`

console.log('============================================================')
console.log(' PROVAUTH — two sign-ins on the OAuth roads: browser (OpenAI) · device code (Hugging Face)')
console.log('============================================================')

const pockets = await import('../../src/utils/accounts/signInPockets.ts')
const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const openai = await import('../../src/services/providers/openai/openaiAccounts.ts')
const huggingface = await import('../../src/services/providers/huggingface/huggingfaceAccounts.ts')
const { runHuggingfaceDeviceLogin } = await import('../../src/services/providers/huggingface/huggingfaceLogin.ts')

const homeOpenai = join(HOME, '.openai-auth.json')
const pocketBob = join(HOME, 'sign-ins', 'openai', 'bob@work.example')

async function browserSignIn(email: string, account: string, refresh: string): Promise<unknown> {
  const handles = openai.beginOpenaiBrowserConnect({
    skipBrowserOpen: true,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ id_token: idToken(email, account), access_token: accessJwt(FUTURE_S, email), refresh_token: refresh, expires_in: 3600 }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch,
  } as never)
  const state = new URL(handles.authorizeUrl).searchParams.get('state')!
  handles.completeWithRedirect(`http://localhost:1455/auth/callback?code=REAL&state=${state}`)
  return within(handles.result)
}

section('§1 the browser-OAuth road: the first ChatGPT sign-in lands in the home, a second account lands in a pocket, the same account replaces')
{
  const first = await browserSignIn('alice@home.example', 'acct-alice', 'R-alice-1')
  const firstLanding = pockets.takeLastLanding()
  check('the first sign-in settles and lands in the home', first !== 'timed-out' && tokensOf(homeOpenai).email === 'alice@home.example' && firstLanding?.landed === 'first', JSON.stringify(firstLanding))
  const homeBefore = bytes(homeOpenai)

  const second = await browserSignIn('bob@work.example', 'acct-bob', 'R-bob-1')
  const secondLanding = pockets.takeLastLanding()
  check('the second account is ADDED as a pocket keyed by its address', second !== 'timed-out' && secondLanding?.landed === 'added' && secondLanding.identity === 'bob@work.example' && secondLanding.dir === pocketBob, JSON.stringify(secondLanding))
  check('the pocket holds bob\'s tokens', existsSync(join(pocketBob, '.openai-auth.json')) && tokensOf(join(pocketBob, '.openai-auth.json')).refreshToken === 'R-bob-1')
  check('the home still holds alice byte for byte', bytes(homeOpenai) === homeBefore)
  check('the session spends bob: the resolver answers his account through the seam', openai.resolveOpenaiAccount()?.email === 'bob@work.example')
  check('under the home bracket the resolver answers alice', pockets.withSignInHome('openai', null, () => openai.resolveOpenaiAccount())?.email === 'alice@home.example')
  const entries = ledger.readSignInEntries('openai', { home: HOME })
  check('the ledger carries both entries, bob\'s with its pocket', entries['alice@home.example']?.kind === 'subscription' && entries['bob@work.example']?.pocket === 'bob@work.example', JSON.stringify(entries))

  const again = await browserSignIn('bob@work.example', 'acct-bob', 'R-bob-2')
  const thirdLanding = pockets.takeLastLanding()
  check('bob signing in again REPLACES inside his pocket', again !== 'timed-out' && thirdLanding?.landed === 'replaced' && thirdLanding.dir === pocketBob && tokensOf(join(pocketBob, '.openai-auth.json')).refreshToken === 'R-bob-2', JSON.stringify(thirdLanding))
  check('alice\'s home file is still untouched', bytes(homeOpenai) === homeBefore)
}

section('§2 credentials never cross: two refreshes interleaved, each rotates only the sign-in it read')
{
  const refreshFetch = (who: string): typeof fetch =>
    (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/oauth/token')) {
        const body = String(init?.body ?? '')
        const presented = new URLSearchParams(body).get('refresh_token') ?? ''
        return new Response(JSON.stringify({ id_token: idToken(who === 'alice' ? 'alice@home.example' : 'bob@work.example', `acct-${who}`), access_token: accessJwt(FUTURE_S, `${who}-rotated`), refresh_token: `${presented}-rotated`, expires_in: 3600 }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
  const expired = (): number => (PAST_S + 1) * 1000
  pockets.setSessionSignIn('openai', { identity: 'bob@work.example', dir: pocketBob, kind: 'chatgpt-subscription' })
  const bobRefresh = openai.currentSubscriptionTokens({ fetchImpl: refreshFetch('bob'), now: () => expired() + 10 * 60_000, force: true })
  pockets.setSessionSignIn('openai', { identity: 'alice@home.example', dir: null, kind: 'chatgpt-subscription' })
  const aliceRefresh = openai.currentSubscriptionTokens({ fetchImpl: refreshFetch('alice'), now: () => expired() + 10 * 60_000, force: true })
  const [bobTokens, aliceTokens] = await Promise.all([within(bobRefresh), within(aliceRefresh)])
  const bobFile = tokensOf(join(pocketBob, '.openai-auth.json'))
  const aliceFile = tokensOf(homeOpenai)
  check('bob\'s refresh answered bob\'s rotation', bobTokens !== 'timed-out' && (bobTokens as { refreshToken?: string } | undefined)?.refreshToken?.startsWith('R-bob') === true, JSON.stringify(bobTokens))
  check('alice\'s refresh answered alice\'s rotation', aliceTokens !== 'timed-out' && (aliceTokens as { refreshToken?: string } | undefined)?.refreshToken?.startsWith('R-alice') === true, JSON.stringify(aliceTokens))
  check('the pocket file holds only bob\'s lineage', String(bobFile.refreshToken).startsWith('R-bob') && bobFile.email === 'bob@work.example', JSON.stringify(bobFile))
  check('the home file holds only alice\'s lineage', String(aliceFile.refreshToken).startsWith('R-alice') && aliceFile.email === 'alice@home.example', JSON.stringify(aliceFile))
  check('no refresh token of one sign-in ever entered the other\'s file', !bytes(homeOpenai).includes('R-bob') && !bytes(join(pocketBob, '.openai-auth.json')).includes('R-alice'))
}

section('§3 a lapsed identity never blocks the other: bob\'s grant dies, alice still resolves and refreshes')
{
  pockets.setSessionSignIn('openai', { identity: 'bob@work.example', dir: pocketBob, kind: 'chatgpt-subscription' })
  const dead = (async (url: RequestInfo | URL) =>
    String(url).includes('/oauth/token') ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : new Response('', { status: 404 })) as unknown as typeof fetch
  const bobDead = await within(openai.currentSubscriptionTokens({ fetchImpl: dead, now: () => (FUTURE_S + 600) * 1000, force: true }))
  check('bob\'s refresh is refused and his sign-in reads dead', bobDead === undefined && openai.openaiSubscriptionPresence().state === 'expired', `${JSON.stringify(bobDead)} ${openai.openaiSubscriptionPresence().state}`)
  pockets.setSessionSignIn('openai', { identity: 'alice@home.example', dir: null, kind: 'chatgpt-subscription' })
  check('alice\'s sign-in still reads connected', openai.openaiSubscriptionPresence().state === 'connected' && openai.resolveOpenaiAccount()?.email === 'alice@home.example', openai.openaiSubscriptionPresence().state)
  check('the dead pocket keeps its identity for the board (present-but-dead)', tokensOf(join(pocketBob, '.openai-auth.json')).email === 'bob@work.example' && tokensOf(join(pocketBob, '.openai-auth.json')).refreshToken === '')
}

const homeHf = join(HOME, '.huggingface-auth.json')
const pocketHf = join(HOME, 'sign-ins', 'huggingface', 'second-user')

async function deviceSignIn(username: string | undefined, access: string, refresh: string): Promise<unknown> {
  return within(
    runHuggingfaceDeviceLogin({
      cancelled: () => false,
      sleep: () => Promise.resolve(),
      refreshCatalogue: () => Promise.resolve(null),
      io: {
        env: { ...process.env, MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture' },
        fetchImpl: (async (url: RequestInfo | URL) => {
          const u = String(url)
          if (u.includes('/oauth/device')) return new Response(JSON.stringify({ device_code: 'DC', user_code: 'USER', verification_uri: 'https://hf.example/activate', interval: 0, expires_in: 300 }), { status: 200 })
          if (u.includes('/oauth/token')) return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }), { status: 200 })
          if (u.includes('/api/whoami-v2')) return new Response(JSON.stringify(username === undefined ? {} : { name: username, fullname: username }), { status: 200 })
          return new Response('', { status: 404 })
        }) as unknown as typeof fetch,
      },
    } as never),
  )
}

section('§4 the device-code road: the first Hub sign-in lands in the home, a second user lands in a pocket keyed by the username')
{
  const first = await deviceSignIn('first-user', 'hf-A-1', 'hf-R-1')
  const firstLanding = pockets.takeLastLanding()
  check('the first device sign-in lands in the home', first !== 'timed-out' && (first as { ok: boolean }).ok && huggingface.huggingfaceOauthIdentity()?.username === 'first-user' && firstLanding?.landed === 'first', JSON.stringify(firstLanding))
  const homeBefore = bytes(homeHf)
  const second = await deviceSignIn('second-user', 'hf-A-2', 'hf-R-2')
  const secondLanding = pockets.takeLastLanding()
  check('the second user is ADDED as a pocket keyed by the username', second !== 'timed-out' && (second as { ok: boolean }).ok && secondLanding?.landed === 'added' && secondLanding.identity === 'second-user' && secondLanding.dir === pocketHf, JSON.stringify(secondLanding))
  check('the pocket holds the second user\'s tokens and identity', existsSync(join(pocketHf, '.huggingface-auth.json')) && tokensOf(join(pocketHf, '.huggingface-auth.json')).accessToken === 'hf-A-2' && (json(join(pocketHf, '.huggingface-auth.json')).identity as { username: string }).username === 'second-user')
  check('the home file is untouched', bytes(homeHf) === homeBefore)
  check('the session spends the second user through the seam', huggingface.huggingfaceOauthIdentity()?.username === 'second-user' && huggingface.huggingfaceStoredTokens()?.accessToken === 'hf-A-2')
  check('the home bracket still answers the first user', pockets.withSignInHome('huggingface', null, () => huggingface.huggingfaceOauthIdentity())?.username === 'first-user')
  const landing = pockets.landingWords(secondLanding!, 'Hugging Face')
  check('the landing words name the add and the way back', /added beside first-user/.test(landing) && /\/logins use first-user/.test(landing), landing)
}

section('§5 forget the second user: the pocket and its row go, the first user stays, the choice falls back')
{
  const entry = pockets.pocketEntries('huggingface', HOME)[0]!
  const outcome = pockets.forgetPocket('huggingface', entry, () => huggingface.disconnectHuggingfaceOauth(), HOME)
  check('forget removes the pocket and the choice falls back', outcome.removed && outcome.choiceFell && !existsSync(pocketHf))
  check('the first user still stands in the home and now spends', huggingface.huggingfaceOauthIdentity()?.username === 'first-user' && huggingface.huggingfaceStoredTokens()?.accessToken === 'hf-A-1')
  check('the ledger keeps only the home row', Object.keys(ledger.readSignInEntries('huggingface', { home: HOME })).join(',') === 'first-user')
}

section('§6 a sign-in without a usable name never gets a neighbour: the next named sign-in replaces it in the home, and the unnamed row goes')
{
  pockets.withSignInHome('huggingface', null, () => huggingface.disconnectHuggingfaceOauth())
  ledger.dropSignInEntry('huggingface', 'first-user', { home: HOME })
  const unnamed = await deviceSignIn(undefined, 'hf-A-3', 'hf-R-3')
  const unnamedLanding = pockets.takeLastLanding()
  const rows = ledger.readSignInEntries('huggingface', { home: HOME })
  check('a Hub sign-in whose whoami carries no name lands in the home, marked unnamed in the ledger', unnamed !== 'timed-out' && (unnamed as { ok: boolean }).ok && unnamedLanding?.landed === 'first' && unnamedLanding.dir === null && Object.values(rows).length === 1 && Object.values(rows)[0]?.unnamed === true, JSON.stringify({ unnamedLanding, rows }))
  const named = await deviceSignIn('third-user', 'hf-A-4', 'hf-R-4')
  const namedLanding = pockets.takeLastLanding()
  check('the next named sign-in REPLACES the unnamed one in the home — no pocket', named !== 'timed-out' && (named as { ok: boolean }).ok && namedLanding?.landed === 'replaced' && namedLanding.dir === null && namedLanding.replaced === unnamedLanding?.identity && !existsSync(join(HOME, 'sign-ins', 'huggingface')), JSON.stringify(namedLanding))
  check('the ledger holds the named row alone, not marked unnamed', Object.keys(ledger.readSignInEntries('huggingface', { home: HOME })).join(',') === 'third-user' && ledger.readSignInEntries('huggingface', { home: HOME })['third-user']?.unnamed === undefined)
  check('the home spends the named user', huggingface.huggingfaceOauthIdentity()?.username === 'third-user' && huggingface.huggingfaceStoredTokens()?.accessToken === 'hf-A-4')
  const words = pockets.landingWords(namedLanding!, 'Hugging Face')
  check('the landing words say the replacement and name both', /third-user replaces hf-/.test(words) && /no usable name/.test(words), words)
  check('hidden, the words carry no identity', !pockets.landingWords(namedLanding!, 'Hugging Face', false).includes('third-user'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ TWO SIGN-INS ON THE OAUTH ROADS GREEN' : `\n❌ TWO SIGN-INS ON THE OAUTH ROADS RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
