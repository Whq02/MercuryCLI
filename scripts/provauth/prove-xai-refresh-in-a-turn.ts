#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { existsSync, readFileSync } from 'node:fs'
import type { CallModelParams } from '../../src/models/roads/callModelContract.ts'

process.env.MERCURY_CONFIG_DIR = proofHome
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of Object.keys(process.env)) {
  if (ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) || /proxy/i.test(name) || name === 'MERCURY_MODEL' || name === 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC') delete process.env[name]
}

const FIX = {
  turn: 'the turn\'s credential is resolveXaiCredential in src/models/roads/xai/xaiAccounts.ts (a refresh that fails while the access token is still good rides that token) and the subscription profile of xaiCallModel in src/models/roads/xai/xaiCallModel.ts (a refresh failure is kept as the words of the refusal, never thrown out of the turn)',
  store: 'the refresh is refreshXaiTokens in src/models/roads/xai/xaiOauth.ts, on the door src/models/sign-in/lifecycle/lockedRefresh.ts: a refused grant blanks the refresh token and keeps the row, any other failure writes nothing',
}
let failures = 0
let passes = 0
function check(label: string, ok: boolean, fix: string, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${fix}; the stand-in is the Bun.serve block of scripts/provauth/prove-xai-refresh-in-a-turn.ts`}`)
}

const ACCESS = 'grok-access-fixture-0001'
const ACCESS_RENEWED = 'grok-access-fixture-0002'
const KEY = 'xai-stored-key-fixture-0001'
const REFRESH_FAILED_503 = 'Grok sign-in refresh failed (HTTP 503); /logins xai reconnects it. No API-key fallback was used.'
const REFRESH_FAILED_400 = 'Grok sign-in refresh failed (HTTP 400); /logins xai reconnects it. No API-key fallback was used.'
const WALL = 'xAI sign-in expired — switch providers (/model) or reconnect (/logins xai)'
const NO_SIGN_IN = 'no usable Grok sign-in or xAI API key'

type Hit = { path: string; bearer: string | null; refreshToken: string | null }
const hits: Hit[] = []
let tokenAnswer: { status: number; body: Record<string, unknown> } = { status: 503, body: { error: 'temporarily_unavailable' } }
let rejectedBearers = new Set<string>()
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const standIn = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const bearer = request.headers.get('authorization')
    if (path === '/oauth2/token') {
      const form = new URLSearchParams(await request.text())
      hits.push({ path, bearer, refreshToken: form.get('refresh_token') })
      return Response.json(tokenAnswer.body, { status: tokenAnswer.status })
    }
    hits.push({ path, bearer, refreshToken: null })
    if (path === '/proxy/v1/models') return Response.json({ object: 'list', data: [{ id: 'grok-4.7', object: 'model', owned_by: 'xAI', model: 'grok-4.7', model_family: 'xai', name: 'Grok 4.7', context_window: 256000 }] })
    if (path === '/proxy/v1/responses') {
      const body = (await request.json()) as { model?: string }
      if (bearer !== null && rejectedBearers.has(bearer)) return Response.json({ error: 'Invalid or expired credentials (auth_kind=bearer, upstream=Unauthenticated)' }, { status: 401, headers: { 'x-should-retry': 'false' } })
      const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'settled', annotations: [] }], status: 'completed' }
      return new Response(
        sse({ type: 'response.created', response: { id: 'resp_fixture', model: body.model, status: 'in_progress' } }) +
          sse({ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'settled' }) +
          sse({ type: 'response.output_item.done', output_index: 0, item }) +
          sse({ type: 'response.completed', response: { id: 'resp_fixture', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return new Response(null, { status: 404 })
  },
})
const base = `http://127.0.0.1:${standIn.port}`
Object.assign(process.env, { MERCURY_XAI_AUTH_BASE: base, MERCURY_XAI_API_BASE: `${base}/v1`, MERCURY_XAI_GROK_PROXY_BASE: `${base}/proxy/v1` })

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const oauth = await import('../../src/models/roads/xai/xaiOauth.ts')
const catalogue = await import('../../src/models/roads/xai/xaiCatalogue.ts')
const secrets = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { deriveFamilySlotGroups } = await import('../../src/models/roads/accountSlots.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')

type Turn = { texts: string[]; errors: string[]; threw: string | null; chats: Hit[]; refreshes: Hit[] }
async function turn(): Promise<Turn> {
  const before = hits.length
  const texts: string[] = []
  const errors: string[] = []
  let threw: string | null = null
  const params: CallModelParams = {
    messages: [createUserMessage({ content: 'say hi' })],
    systemPrompt: asSystemPrompt(['Fixture system']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: { model: 'grok-4.7', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false },
  }
  try {
    for await (const item of routedCallModel(params)) {
      if (item.type !== 'assistant') continue
      const text = item.message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
      if (item.isApiErrorMessage) errors.push(text)
      else texts.push(text)
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  const seen = hits.slice(before)
  return { texts, errors, threw, chats: seen.filter(hit => hit.path === '/proxy/v1/responses'), refreshes: seen.filter(hit => hit.path === '/oauth2/token') }
}
const show = (run: Turn): string => JSON.stringify({ texts: run.texts, errors: run.errors, threw: run.threw, chats: run.chats.map(hit => hit.bearer), refreshes: run.refreshes.length })
const store = oauth.xaiAuthPathForDisplay()
type Row = { accessToken?: string; refreshToken?: string }
const row = (): Row | undefined => (existsSync(store) ? (JSON.parse(readFileSync(store, 'utf8')) as { tokens?: Row }).tokens : undefined)
const slot = () => deriveFamilySlotGroups().flatMap(group => group.slots).find(each => each.id === 'xai:oauth')
let signIns = 0
function signedIn(expiresInMs: number): string {
  const refreshToken = `grok-refresh-fixture-${String(++signIns).padStart(4, '0')}`
  oauth.writeXaiTokens({ accessToken: ACCESS, refreshToken, expiresAtMs: Date.now() + expiresInMs, email: 'fixture@example.invalid' })
  oauth.writePreferredXaiSource('grok-subscription')
  catalogue.__resetXaiCatalogueForTest()
  return refreshToken
}

try {
  check('the proof writes under its own scratch home', store.startsWith(proofHome), FIX.store, store)
  secrets.writeStoredXaiApiKey(KEY)

  console.log('── the token server is down while the access token is still good: the turn goes on it ──')
  const standing = signedIn(60_000)
  tokenAnswer = { status: 503, body: { error: 'temporarily_unavailable' } }
  const stillGood = await turn()
  check('nothing is thrown out of the turn', stillGood.threw === null, FIX.turn, show(stillGood))
  check('the turn settles on the subscription with the access token that stands', stillGood.errors.length === 0 && stillGood.texts.includes('settled') && stillGood.chats.length === 1 && stillGood.chats[0]!.bearer === `Bearer ${ACCESS}`, FIX.turn, show(stillGood))
  check('the refresh was tried and the store is as it was', stillGood.refreshes.length >= 1 && row()?.refreshToken === standing && row()?.accessToken === ACCESS, FIX.store, JSON.stringify(row() ?? null))

  console.log('── the token server is down and the access token has run out: a refusal that keeps the reason ──')
  const ranOutToken = signedIn(-1_000)
  const ranOut = await turn()
  check('nothing is thrown out of the turn', ranOut.threw === null, FIX.turn, show(ranOut))
  check('the turn is refused in one row that says why the refresh failed, and nothing reaches the chat wire', ranOut.errors.length === 1 && ranOut.errors[0]!.includes(REFRESH_FAILED_503) && ranOut.chats.length === 0, FIX.turn, show(ranOut))
  check('no stored key was used and the sign-in is kept whole', ranOut.chats.every(hit => hit.bearer !== `Bearer ${KEY}`) && row()?.refreshToken === ranOutToken && slot()?.signedIn === true, FIX.store, JSON.stringify(row() ?? null))

  console.log('── the grant is refused in the turn itself: a refusal that keeps the reason, the row kept as expired ──')
  const refusedToken = signedIn(3_600_000)
  const listRead = await turn()
  check('a turn on the good sign-in reads the model list and settles', listRead.threw === null && listRead.texts.includes('settled') && listRead.refreshes.length === 0, FIX.turn, show(listRead))
  oauth.writeXaiTokens({ accessToken: ACCESS, refreshToken: refusedToken, expiresAtMs: Date.now() - 1_000, email: 'fixture@example.invalid' })
  tokenAnswer = { status: 400, body: { error: 'invalid_grant' } }
  const refused = await turn()
  check('nothing is thrown out of the turn', refused.threw === null, FIX.turn, show(refused))
  check('the turn is refused in one row that says the refresh was refused', refused.errors.length === 1 && refused.errors[0]!.includes(REFRESH_FAILED_400) && refused.chats.length === 0, FIX.turn, show(refused))
  check('the row is kept with a blank refresh token and reads sign-in expired', row()?.refreshToken === '' && row()?.accessToken === ACCESS && !readFileSync(store, 'utf8').includes(refusedToken) && slot()?.signedIn === false && slot()?.stateNote === 'sign-in expired — /logins xai reconnects it', FIX.store, JSON.stringify({ row: row() ?? null, slot: slot() ?? null }))
  const afterRefusal = await turn()
  check('the next turn is refused with the road\'s own line and sends nothing to the token server', afterRefusal.threw === null && afterRefusal.errors.length === 1 && afterRefusal.errors[0]!.includes(NO_SIGN_IN) && afterRefusal.refreshes.length === 0 && afterRefusal.chats.length === 0, FIX.turn, show(afterRefusal))

  console.log('── the grant is refused while the model list is read: the row kept as expired, the road\'s own line ──')
  signedIn(-1_000)
  const refusedAtTheList = await turn()
  check('the turn is refused with the road\'s own line, as on 1.1.0, and the row reads sign-in expired', refusedAtTheList.threw === null && refusedAtTheList.errors.length === 1 && refusedAtTheList.errors[0]!.includes(NO_SIGN_IN) && refusedAtTheList.chats.length === 0 && row()?.refreshToken === '' && slot()?.stateNote === 'sign-in expired — /logins xai reconnects it', FIX.store, show(refusedAtTheList))

  console.log('── the access token is rejected by the road and the token server is down: the row says so ──')
  const rejectedToken = signedIn(3_600_000)
  rejectedBearers = new Set([`Bearer ${ACCESS}`])
  tokenAnswer = { status: 503, body: { error: 'temporarily_unavailable' } }
  const rejected = await turn()
  check('nothing is thrown out of the turn', rejected.threw === null, FIX.turn, show(rejected))
  check('one row: the road rejected the credential, and why the refresh failed', rejected.errors.length === 1 && rejected.errors[0]!.includes('xAI rejected the credential') && rejected.errors[0]!.includes(REFRESH_FAILED_503) && rejected.refreshes.length === 1, FIX.turn, show(rejected))
  check('that row does not say the sign-in expired, and the sign-in is kept whole', !rejected.errors.join(' ').includes(WALL) && row()?.refreshToken === rejectedToken, FIX.turn, show(rejected))

  console.log('── the access token is rejected and the grant is refused: the sign-in did expire ──')
  tokenAnswer = { status: 400, body: { error: 'invalid_grant' } }
  const expired = await turn()
  check('one row with the sentence an expired sign-in already has, and the row kept blank', expired.threw === null && expired.errors.length === 1 && expired.errors[0]!.includes(WALL) && row()?.refreshToken === '', FIX.turn, show(expired))

  console.log('── the access token is rejected and the refresh answers: the turn settles on the new pair ──')
  signedIn(3_600_000)
  tokenAnswer = { status: 200, body: { access_token: ACCESS_RENEWED, refresh_token: 'grok-refresh-of-the-new-pair', expires_in: 3600 } }
  const renewed = await turn()
  check('one refresh, then the retry settles with the new access token', renewed.threw === null && renewed.errors.length === 0 && renewed.texts.includes('settled') && renewed.refreshes.length === 1 && renewed.chats.map(hit => hit.bearer).join(',') === `Bearer ${ACCESS},Bearer ${ACCESS_RENEWED}` && row()?.refreshToken === 'grok-refresh-of-the-new-pair', FIX.turn, show(renewed))
} finally {
  void standIn.stop(true)
}
console.log(failures === 0 ? `\nXAI REFRESH IN A TURN GREEN (${passes} checks; loopback stand-in, no live host)` : `\n${failures} FAILURE(S) of ${passes + failures}`)
process.exit(failures === 0 ? 0 : 1)
