#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.ANTHROPIC_API_KEY
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'oauth-refresh-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_MAX_RETRIES = '2'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'picked up' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')

const revokedBearers = new Set<string>()
const apiRequests: Array<{ bearer: string; status: number }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (revokedBearers.has(bearer)) {
        apiRequests.push({ bearer, status: 401 })
        res.writeHead(401, {
          'content-type': 'application/json',
          ...(bearer === 'at-stale-c' ? { 'x-should-retry': 'false' } : {}),
        })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token revoked (fixture)' } }))
        return
      }
      apiRequests.push({ bearer, status: 200 })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse())
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
})

type TokenGrant = { access: string; rotateRefreshTo?: string } | { invalidGrant: true }
let tokenGrant: TokenGrant = { access: 'unset' }
let tokenPosts = 0
let profileGets = 0
let usageGets = 0
const unexpectedAxios: string[] = []
axios.defaults.adapter = async config => {
  const url = String(config.url ?? '')
  const method = (config.method ?? 'get').toLowerCase()
  const respond = (status: number, data: unknown): never =>
    ({ status, statusText: status === 200 ? 'OK' : 'Bad Request', data, headers: {}, config }) as never
  if (method === 'post' && url.endsWith('/v1/oauth/token')) {
    tokenPosts++
    if ('invalidGrant' in tokenGrant) {
      const error = new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config as never, {}, {
        status: 400,
        statusText: 'Bad Request',
        data: { error: 'invalid_grant', error_description: 'refresh token revoked (fixture)' },
        headers: {},
        config,
      } as never)
      throw error
    }
    const body = JSON.parse(String(config.data ?? '{}')) as { grant_type?: string; refresh_token?: string }
    if (body.grant_type !== 'refresh_token') {
      unexpectedAxios.push(`token POST with grant_type=${body.grant_type}`)
    }
    return respond(200, {
      access_token: tokenGrant.access,
      refresh_token: tokenGrant.rotateRefreshTo,
      expires_in: 3600,
      scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    })
  }
  if (method === 'get' && url.endsWith('/api/oauth/profile')) {
    profileGets++
    return respond(200, {
      account: { uuid: 'acc-fixture', email_address: 'fixture@example.invalid', display_name: 'Fixture', created_at: '2026-01-01T00:00:00Z' },
      organization: { uuid: 'org-fixture', name: 'Fixture Org', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', billing_type: 'stripe_subscription', subscription_created_at: '2026-01-01T00:00:00Z' },
    })
  }
  if (method === 'get' && url === `${base}/api/oauth/usage`) {
    usageGets++
    return respond(200, { five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600000).toISOString() }, seven_day: null })
  }
  unexpectedAxios.push(`${method.toUpperCase()} ${url}`)
  return respond(500, { error: 'unexpected axios egress in fixture' })
}

console.log('============================================================')
console.log(' oauth refresh on switch — the credential path, all shapes')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const auth = { ...(await import('../../src/models/sign-in/credentials/auth.ts')), ...(await import('../../src/models/sign-in/lifecycle/oauthLifecycle.ts')) }
const { SUBSCRIPTION_OAUTH_SCOPES } = await import('../../src/models/sign-in/oauth/oauth.ts')
type AssistantMessage = import('../../src/engine/message-shapes/message.ts').AssistantMessage
type Message = import('../../src/engine/message-shapes/message.ts').Message

const HISTORY: Message[] = [createUserMessage({ content: 'pick up where the last model stopped' })]

async function drive(): Promise<{ last: AssistantMessage | undefined; errors: AssistantMessage[]; threw: unknown }> {
  const assistants: AssistantMessage[] = []
  let threw: unknown
  try {
    for await (const item of routedCallModel({
      messages: HISTORY as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'claude-opus-5',
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
    }
  } catch (error) {
    threw = error
  }
  return {
    last: assistants.filter(a => !a.isApiErrorMessage).at(-1),
    errors: assistants.filter(a => a.isApiErrorMessage),
    threw,
  }
}

function seed(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  auth.saveOAuthTokensIfNeeded({
    ...tokens,
    scopes: [...SUBSCRIPTION_OAUTH_SCOPES],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
  } as never)
  auth.clearOAuthTokenCache()
}

section('A · proactive — an EXPIRED stored token refreshes before request 1')
{
  seed({ accessToken: 'at-stale-a', refreshToken: 'rt-a', expiresAt: Date.now() - 60_000 })
  tokenGrant = { access: 'at-fresh-a' }
  const before = { posts: tokenPosts, api: apiRequests.length }
  const o = await drive()
  const mine = apiRequests.slice(before.api)
  check('subscriber path live (no env token shadowing the stored OAuth)', auth.isClaudeAISubscriber(), 'isClaudeAISubscriber()=false — seeding failed')
  check('exactly ONE token POST before the first API request', tokenPosts - before.posts === 1, `posts=${tokenPosts - before.posts} — an expired stored token must refresh once before request 1; see checkAndRefreshOAuthTokenIfNeeded in src/models/sign-in/lifecycle/oauthLifecycle.ts`)
  check('the API request carries the REFRESHED bearer, first try', mine.length === 1 && mine[0]?.bearer === 'at-fresh-a', `requests=${JSON.stringify(mine)} — the first request must carry the refreshed bearer; see checkAndRefreshOAuthTokenIfNeeded in src/models/sign-in/lifecycle/oauthLifecycle.ts`)
  check('the turn settled end_turn with no error surfaced', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)} errors=${o.errors.length} — the turn must complete after the proactive refresh; look at routedCallModel in src/models/roads/callModelRouter.ts`)
  check('the refreshed credential was persisted', auth.getClaudeAIOAuthTokens()?.accessToken === 'at-fresh-a', 'refresh must save the new tokens; see saveOAuthTokensIfNeeded in src/models/sign-in/lifecycle/oauthLifecycle.ts')
}

section('B · reactive — a server-revoked (unexpired) token 401s, refresh heals the retry')
{
  seed({ accessToken: 'at-revoked-b', refreshToken: 'rt-b', expiresAt: Date.now() + 3_600_000 })
  revokedBearers.add('at-revoked-b')
  tokenGrant = { access: 'at-fresh-b', rotateRefreshTo: 'rt-b2' }
  const before = { posts: tokenPosts, api: apiRequests.length }
  const o = await drive()
  const mine = apiRequests.slice(before.api)
  check('request 1 went out with the revoked bearer and 401d (no proactive refresh — token looked fresh)', mine[0]?.bearer === 'at-revoked-b' && mine[0]?.status === 401, `requests=${JSON.stringify(mine)} — the fixture revokes at-revoked-b; check the request path in routedCallModel (src/models/roads/callModelRouter.ts) sends the stored bearer`)
  check('the 401 triggered exactly ONE refresh POST', tokenPosts - before.posts === 1, `posts=${tokenPosts - before.posts} — a 401 must trigger one forced refresh; see handleOAuth401Error in src/models/sign-in/lifecycle/oauthLifecycle.ts and its call in src/engine/requests/withRetry.ts`)
  check('the RETRIED request carries the refreshed bearer and succeeds', mine.length === 2 && mine[1]?.bearer === 'at-fresh-b' && mine[1]?.status === 200, `requests=${JSON.stringify(mine)} — the retry after a 401 must use the refreshed bearer; see src/engine/requests/withRetry.ts`)
  check('the turn settled end_turn — a 401 heals, it never wedges', o.threw === undefined && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)} — the 401 retry must end the turn; see src/engine/requests/withRetry.ts`)
  check('the rotated refresh token was persisted', auth.getClaudeAIOAuthTokens()?.refreshToken === 'rt-b2', 'the refresh must persist the rotated refresh token; see saveOAuthTokensIfNeeded in src/models/sign-in/lifecycle/oauthLifecycle.ts')
  check('the retry refreshes the usage reading on the same fixture account', usageGets === 1, `gets=${usageGets} — expected one usage fetch after the retry; the fixture counts GET /api/oauth/usage`)
  revokedBearers.clear()
}

section('C · dead refresh token — invalid_grant is a typed, bounded refusal')
{
  seed({ accessToken: 'at-stale-c', refreshToken: 'rt-dead', expiresAt: Date.now() - 60_000 })
  tokenGrant = { invalidGrant: true }
  const before = { posts: tokenPosts }
  const healed = await auth.handleOAuth401Error('at-stale-c')
  check('C1: handleOAuth401Error reports NOT healed on invalid_grant', healed === false, `healed=${String(healed)} — handleOAuth401Error in src/models/sign-in/lifecycle/oauthLifecycle.ts must return false when the refresh ends in invalid_grant`)
  check('C1: exactly one token POST was spent', tokenPosts - before.posts === 1, `posts=${tokenPosts - before.posts}`)
  const blanked = auth.getClaudeAIOAuthTokens()
  check('C1: the dead refresh token is BLANKED on disk; the record survives', blanked !== null && blanked?.refreshToken === '', `refreshToken=${JSON.stringify(blanked?.refreshToken)} — see blankRefreshTokenOnDisk in src/models/sign-in/lifecycle/oauthLifecycle.ts`)
  const posts2 = tokenPosts
  await auth.handleOAuth401Error('at-stale-c')
  check('C1: known-dead latch — no second token POST for the same credential', tokenPosts === posts2, `posts=${tokenPosts - posts2} — see markKnownDeadRefreshToken and isOAuthRefreshKnownDead use in src/models/sign-in/lifecycle/oauthLifecycle.ts`)

  revokedBearers.add('at-stale-c')
  const beforeApi = apiRequests.length
  const started = Date.now()
  const o = await drive()
  const mine = apiRequests.slice(beforeApi)
  const durationMs = Date.now() - started
  check('C2: the dead-credential drive ENDS (bounded, not a wedge)', durationMs < 30_000, `took ${durationMs}ms`)
  check('C2: a typed API error surfaced (never silence)', o.errors.length > 0 || o.threw !== undefined, `errors=${o.errors.length} threw=${String(o.threw)}`)
  check('C2: no request ever succeeded with the dead credential', mine.every(r => r.status === 401), `requests=${JSON.stringify(mine)}`)
  revokedBearers.clear()
}

check('no unexpected axios egress left the process', unexpectedAxios.length === 0, unexpectedAxios.join('; '))
check('the profile fetch stayed on the intercepted seam', profileGets >= 1, `gets=${profileGets}`)

server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
