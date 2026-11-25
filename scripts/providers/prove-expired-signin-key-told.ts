#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_MODEL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[name]

const FIX = {
  told: 'the sentence is signInExpiredOnKeyLine in src/models/roads/credentialWall.ts; the credential carries it from the road\'s resolver (resolveMoonshotDispatchCredential in src/models/roads/moonshot/moonshotAccounts.ts, resolveHuggingfaceDispatchCredential in src/models/roads/huggingface/huggingfaceAccounts.ts) and credentialNotes in src/models/roads/openaicompat/chat-call-model/lane.ts puts it at the head of the reply through compatChatCallModel',
  row: 'a refused refresh keeps the row with a blank refresh token (refreshMoonshotTokens in src/models/roads/moonshot/moonshotAccounts.ts, refreshHuggingfaceTokens in src/models/roads/huggingface/huggingfaceAccounts.ts); moonshotSignInExpired and huggingfaceSignInExpired there say which row is expired, and src/models/roads/account-slots/moonshot.ts and huggingface.ts draw the rows',
  wire: 'the stored key is chosen at the end of the road\'s resolver (resolveMoonshotDispatchCredential, resolveHuggingfaceDispatchCredential); the stand-in server is the createServer block of scripts/providers/prove-expired-signin-key-told.ts',
}
let failures = 0
let passes = 0
function check(label: string, ok: boolean, fix: string, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${fix}`}`)
}

const KIMI_ACCESS = 'kimi-access-fixture-000000000001'
const KIMI_ACCESS_NEW = 'kimi-access-fixture-000000000002'
const KIMI_REFRESH = 'kimi-refresh-fixture-00000000001'
const MOONSHOT_KEY = 'moonshot-stored-key-fixture-0001'
const KIMI_LINE = 'Moonshot sign-in expired — this turn runs on the stored API key and is billed to it; reconnect (/logins moonshot)'
const KIMI_ROW_WORDS = 'access token expired with no refresh route — /logins moonshot signs in again'
const HF_ACCESS = 'hf_oauth_access_fixture_00000001'
const HF_REFRESH = 'hf_oauth_refresh_fixture_0000001'
const HF_KEY = 'hf_stored_token_fixture_00000001'
const HF_MODEL = 'huggingface/openai/gpt-oss-120b'
const HF_LINE = 'Hugging Face sign-in expired — this turn runs on the stored API key and is billed to it; reconnect (/logins huggingface)'
const HF_ROW_WORDS = 'access token expired with no refresh route — /logins reconnects Hugging Face'

type Hit = { path: string; bearer: string | undefined; form: URLSearchParams }
const hits: Hit[] = []
let refreshAnswer: { status: number; body: unknown } = { status: 400, body: { error: 'invalid_grant', error_description: 'the refresh token was revoked' } }
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const auth = req.headers.authorization
    hits.push({ path, bearer: typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : undefined, form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) })
    if (path === '/kimi/oauth/api/oauth/token' || path === '/hf/hub/oauth/token') return json(res, refreshAnswer.status, refreshAnswer.body)
    if (path === '/hf/hub/api/whoami-v2') return json(res, 200, { name: 'fixture-user' })
    if (path === '/hf/router/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'openai/gpt-oss-120b', object: 'model', owned_by: 'openai', providers: [{ provider: 'fixture', status: 'live', supports_tools: true }] }] })
    if (path.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot' }] })
    if (path.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'kimi-k3', choices: [{ index: 0, delta: { role: 'assistant', content: 'settled' }, finish_reason: null }] }) +
          sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'kimi-k3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) +
          'data: [DONE]\n\n',
      )
      return
    }
    json(res, 404, {})
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, {
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/kimi/oauth`,
  MERCURY_MOONSHOT_CODING_BASE: `${base}/kimi/coding/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/router/v1`,
})

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const kimi = await import('../../src/models/roads/moonshot/moonshotAccounts.ts')
const kimiCatalogue = await import('../../src/models/roads/moonshot/moonshotCatalogue.ts')
const hf = await import('../../src/models/roads/huggingface/huggingfaceAccounts.ts')
const secrets = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/models/roads/accountSlots.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message
type AssistantMessage = import('../../src/engine/message-shapes/message.ts').AssistantMessage

type Turn = { texts: string[]; errors: string[]; rows: AssistantMessage[]; chats: Hit[]; refreshes: Hit[] }
async function turn(model: string, history: Message[], querySource = 'main_thread'): Promise<Turn> {
  const before = hits.length
  const texts: string[] = []
  const errors: string[] = []
  const rows: AssistantMessage[] = []
  for await (const item of routedCallModel({
    messages: [...history, createUserMessage({ content: 'say hi' })] as never,
    systemPrompt: ['Fixture system'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model, querySource, isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], hasPendingMcpServers: false } as never,
  })) {
    if (item.type !== 'assistant') continue
    const text = item.message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    if (item.isApiErrorMessage) errors.push(text)
    else {
      texts.push(text)
      rows.push(item as AssistantMessage)
    }
  }
  const seen = hits.slice(before)
  return { texts, errors, rows, chats: seen.filter(hit => hit.path.endsWith('/chat/completions')), refreshes: seen.filter(hit => hit.path.endsWith('/oauth/token')) }
}
const slotOf = (id: string) => deriveFamilySlotGroups().flatMap(group => group.slots).find(slot => slot.id === id)
type StoredRow = { accessToken?: string; refreshToken?: string }
function storedRow(path: string): StoredRow | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { tokens?: StoredRow }).tokens : undefined
}
const show = (run: Turn): string => JSON.stringify({ texts: run.texts, errors: run.errors, chats: run.chats.map(hit => [hit.path, hit.bearer]), refreshes: run.refreshes.length })
function kimiSignedIn(expiresInMs: number, refresh: 'with a refresh token' | 'with no refresh token' = 'with a refresh token'): void {
  kimi.writeMoonshotTokens({ accessToken: KIMI_ACCESS, ...(refresh === 'with a refresh token' ? { refreshToken: KIMI_REFRESH } : {}), accessTokenExpiresAtMs: Date.now() + expiresInMs }, 'global')
  kimiCatalogue.__resetMoonshotCatalogueForTest()
}

try {
  console.log('── Kimi: the refresh is refused and a stored key stands: the turn goes on the key and says so ──')
  secrets.writeStoredMoonshotApiKey(MOONSHOT_KEY)
  kimiSignedIn(30_000)
  const refused = await turn('kimi-k3', [])
  check('the turn still goes: it settles on the platform base with the stored key', refused.errors.length === 0 && refused.texts.includes('settled') && refused.chats.length === 1 && refused.chats[0]!.path === '/moonshot/v1/chat/completions' && refused.chats[0]!.bearer === MOONSHOT_KEY, FIX.wire, show(refused))
  check('one refresh was sent with the stored refresh token, and it was refused', refused.refreshes.length === 1 && refused.refreshes[0]!.form.get('refresh_token') === KIMI_REFRESH, FIX.wire, show(refused))
  check('the reply opens with the one line that says which credential pays', refused.texts[0] === KIMI_LINE && refused.texts.filter(text => text === KIMI_LINE).length === 1, FIX.told, show(refused))
  const expiredRow = slotOf('moonshot:oauth')
  check('the sign-in row is kept, signed out, with the words an expired sign-in already has', expiredRow !== undefined && expiredRow.signedIn === false && expiredRow.active === false && expiredRow.stateNote === KIMI_ROW_WORDS, FIX.row, JSON.stringify(expiredRow ?? null))
  const keyRow = slotOf('moonshot:stored-key')
  check('the stored key reads as the active source, not as shadowed', keyRow?.active === true && keyRow.stateNote === undefined, FIX.row, JSON.stringify(keyRow ?? null))
  const kimiStore = kimi.moonshotAuthPathForDisplay()
  check('the refused refresh token is gone from the store and the row holds a blank one', storedRow(kimiStore)?.refreshToken === '' && storedRow(kimiStore)?.accessToken === KIMI_ACCESS && !readFileSync(kimiStore, 'utf8').includes(KIMI_REFRESH), FIX.row, JSON.stringify(storedRow(kimiStore) ?? null))
  check('every other reader sees the key, as after the wipe on 1.1.0', kimi.moonshotStoredTokens() === undefined && kimi.resolveMoonshotAccount()?.kind === 'api-key' && kimi.moonshotDispatchSource() === 'stored', FIX.row, JSON.stringify(kimi.resolveMoonshotAccount() ?? null))

  console.log('── once per conversation: the same conversation is not told twice; another one is told once ──')
  const sameTalk = await turn('kimi-k3', [createUserMessage({ content: 'say hi' }), ...refused.rows])
  check('the next turn of that conversation goes on the key without the line', sameTalk.errors.length === 0 && sameTalk.texts.join('|') === 'settled' && sameTalk.chats[0]?.bearer === MOONSHOT_KEY, FIX.told, show(sameTalk))
  const otherTalk = await turn('kimi-k3', [])
  check('a new conversation is told once', otherTalk.texts[0] === KIMI_LINE && otherTalk.texts.filter(text => text === KIMI_LINE).length === 1 && otherTalk.chats[0]?.bearer === MOONSHOT_KEY, FIX.told, show(otherTalk))
  const crewmate = await turn('kimi-k3', [], 'agent:custom')
  check('a crewmate\'s conversation is told too', crewmate.texts[0] === KIMI_LINE, FIX.told, show(crewmate))
  const sideCall = await turn('kimi-k3', [], 'compact')
  check('a side call (compaction) never carries the line', sideCall.errors.length === 0 && sideCall.texts.join('|') === 'settled' && sideCall.chats[0]?.bearer === MOONSHOT_KEY, FIX.told, show(sideCall))
  check('the dead refresh token was never sent again', sameTalk.refreshes.length + otherTalk.refreshes.length + crewmate.refreshes.length + sideCall.refreshes.length === 0, FIX.row, `${sameTalk.refreshes.length + otherTalk.refreshes.length + crewmate.refreshes.length + sideCall.refreshes.length} more refresh posts`)

  console.log('── the second way in: a sign-in with no refresh token whose access token ran out ──')
  kimiSignedIn(-1_000, 'with no refresh token')
  const ranOut = await turn('kimi-k3', [])
  check('the turn goes on the stored key and says so, with nothing sent to the token server', ranOut.errors.length === 0 && ranOut.texts[0] === KIMI_LINE && ranOut.chats[0]?.path === '/moonshot/v1/chat/completions' && ranOut.chats[0]?.bearer === MOONSHOT_KEY && ranOut.refreshes.length === 0, FIX.told, show(ranOut))
  check('that row is kept too', slotOf('moonshot:oauth')?.stateNote === KIMI_ROW_WORDS && storedRow(kimiStore)?.accessToken === KIMI_ACCESS, FIX.row, JSON.stringify(slotOf('moonshot:oauth') ?? null))

  console.log('── what must not be told: a passing failure, a fresh sign-in, an environment key, a removed row ──')
  kimiSignedIn(30_000)
  refreshAnswer = { status: 503, body: {} }
  const outage = await turn('kimi-k3', [])
  check('a token server that is down changes nothing: the turn rides the sign-in, no line, the row whole', outage.errors.length === 0 && outage.texts.join('|') === 'settled' && outage.chats[0]?.path === '/kimi/coding/v1/chat/completions' && outage.chats[0]?.bearer === KIMI_ACCESS && kimi.moonshotStoredTokens()?.refreshToken === KIMI_REFRESH, FIX.row, show(outage))
  refreshAnswer = { status: 400, body: { error: 'invalid_grant' } }
  await turn('kimi-k3', [])
  kimi.writeMoonshotTokens({ accessToken: KIMI_ACCESS_NEW, refreshToken: 'kimi-refresh-fixture-00000000002', accessTokenExpiresAtMs: Date.now() + 3_600_000 }, 'global')
  kimiCatalogue.__resetMoonshotCatalogueForTest()
  const signedInAgain = await turn('kimi-k3', [])
  check('signing in again ends it: the turn rides the new sign-in, no line, the row active', signedInAgain.errors.length === 0 && signedInAgain.texts.join('|') === 'settled' && signedInAgain.chats[0]?.path === '/kimi/coding/v1/chat/completions' && signedInAgain.chats[0]?.bearer === KIMI_ACCESS_NEW && slotOf('moonshot:oauth')?.active === true && slotOf('moonshot:stored-key')?.stateNote === 'shadowed — the Kimi sign-in wins', FIX.row, show(signedInAgain))
  kimiSignedIn(30_000)
  await turn('kimi-k3', [])
  process.env.MOONSHOT_API_KEY = 'moonshot-env-key-fixture-0000001'
  kimiCatalogue.__resetMoonshotCatalogueForTest()
  const envKey = await turn('kimi-k3', [])
  check('a key in the environment is the user\'s own choice: no line', envKey.errors.length === 0 && envKey.texts.join('|') === 'settled' && envKey.chats[0]?.bearer === 'moonshot-env-key-fixture-0000001', FIX.told, show(envKey))
  delete process.env.MOONSHOT_API_KEY
  kimiCatalogue.__resetMoonshotCatalogueForTest()
  const stillExpired = slotOf('moonshot:oauth')
  check('the expired row is still there to remove', stillExpired?.signedIn === false, FIX.row, JSON.stringify(stillExpired ?? null))
  if (stillExpired) executeSlotRemoval(stillExpired)
  const removed = await turn('kimi-k3', [])
  check('removing the expired row ends it: the key alone, no line', slotOf('moonshot:oauth') === undefined && removed.errors.length === 0 && removed.texts.join('|') === 'settled' && removed.chats[0]?.bearer === MOONSHOT_KEY, FIX.told, show(removed))

  console.log('── no stored key: the turn is refused with the words 1.1.0 had, and the row is kept ──')
  secrets.writeStoredMoonshotApiKey(null)
  kimiSignedIn(30_000)
  const noKey = await turn('kimi-k3', [])
  check('nothing reaches the chat wire and the refusal is the road\'s own line', noKey.chats.length === 0 && noKey.errors.length === 1 && noKey.errors[0]!.includes('Kimi sign-in') && !noKey.errors[0]!.includes(KIMI_LINE), FIX.wire, show(noKey))
  check('the row is kept as expired', slotOf('moonshot:oauth')?.stateNote === KIMI_ROW_WORDS, FIX.row, JSON.stringify(slotOf('moonshot:oauth') ?? null))

  console.log('── Hugging Face: the refresh is refused and a stored token stands: the turn goes on it and says so ──')
  const hfSignedIn = (expiresInMs: number): void => hf.writeHuggingfaceTokens({ accessToken: HF_ACCESS, refreshToken: HF_REFRESH, accessTokenExpiresAtMs: Date.now() + expiresInMs, clientId: 'fixture-client' }, { username: 'fixture-user', observedAtMs: Date.now() })
  secrets.writeStoredHuggingfaceApiKey(HF_KEY)
  hfSignedIn(30_000)
  refreshAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'the refresh token was revoked' } }
  const hfRefused = await turn(HF_MODEL, [])
  check('the turn still goes: it settles with the stored token as the bearer', hfRefused.errors.length === 0 && hfRefused.texts.includes('settled') && hfRefused.chats.length === 1 && hfRefused.chats[0]!.path === '/hf/router/v1/chat/completions' && hfRefused.chats[0]!.bearer === HF_KEY, FIX.wire, show(hfRefused))
  check('one refresh was sent with the stored refresh token, and it was refused', hfRefused.refreshes.length === 1 && hfRefused.refreshes[0]!.form.get('refresh_token') === HF_REFRESH, FIX.wire, show(hfRefused))
  check('the reply opens with the one line that says which credential pays', hfRefused.texts[0] === HF_LINE && hfRefused.texts.filter(text => text === HF_LINE).length === 1, FIX.told, show(hfRefused))
  const hfRow = slotOf('huggingface:oauth')
  check('the sign-in row is kept with its username, signed out, with the words an expired sign-in already has', hfRow !== undefined && hfRow.name === 'fixture-user' && hfRow.signedIn === false && hfRow.active === false && hfRow.stateNote === HF_ROW_WORDS, FIX.row, JSON.stringify(hfRow ?? null))
  const hfKeyRow = slotOf('huggingface:stored-key')
  check('the stored token reads as the active source, not as shadowed', hfKeyRow?.active === true && hfKeyRow.stateNote === undefined, FIX.row, JSON.stringify(hfKeyRow ?? null))
  const hfStore = hf.huggingfaceAuthPathForDisplay()
  check('the refused refresh token is gone from the store and the row holds a blank one', storedRow(hfStore)?.refreshToken === '' && storedRow(hfStore)?.accessToken === HF_ACCESS && !readFileSync(hfStore, 'utf8').includes(HF_REFRESH), FIX.row, JSON.stringify(storedRow(hfStore) ?? null))
  check('every other reader sees the stored token, as after the wipe on 1.1.0', hf.huggingfaceStoredTokens() === undefined && hf.resolveHuggingfaceApiKey()?.source === 'stored' && hf.resolveHuggingfaceAccount()?.kind === 'api-key', FIX.row, JSON.stringify(hf.resolveHuggingfaceAccount() ?? null))
  const hfSameTalk = await turn(HF_MODEL, [createUserMessage({ content: 'say hi' }), ...hfRefused.rows])
  check('the next turn of that conversation goes on the stored token without the line, and nothing more goes to the token server', hfSameTalk.errors.length === 0 && hfSameTalk.texts.join('|') === 'settled' && hfSameTalk.chats[0]?.bearer === HF_KEY && hfSameTalk.refreshes.length === 0, FIX.told, show(hfSameTalk))
  const hfSideCall = await turn(HF_MODEL, [], 'generate_session_title')
  check('a side call (the session title) never carries the line', hfSideCall.errors.length === 0 && hfSideCall.texts.join('|') === 'settled', FIX.told, show(hfSideCall))
  hfSignedIn(30_000)
  refreshAnswer = { status: 503, body: {} }
  const hfOutage = await turn(HF_MODEL, [])
  check('a token server that is down changes nothing: the turn rides the sign-in, no line, the row whole', hfOutage.errors.length === 0 && hfOutage.texts.join('|') === 'settled' && hfOutage.chats[0]?.bearer === HF_ACCESS && hf.huggingfaceStoredTokens()?.refreshToken === HF_REFRESH && hf.huggingfaceOauthIdentity()?.username === 'fixture-user', FIX.row, show(hfOutage))
} finally {
  server.close()
}
console.log(failures === 0 ? `\nEXPIRED SIGN-IN, STORED KEY: TOLD (${passes} checks; loopback stand-in, no live host)` : `\n${failures} FAILURE(S) of ${passes + failures}`)
process.exit(failures === 0 ? 0 : 1)
