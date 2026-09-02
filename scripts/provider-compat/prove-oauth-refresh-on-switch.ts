#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-oauth-refresh-on-switch.ts — the Anthropic
//  OAuth credential path under a family switch, proven end-to-end on a
//  loopback fixture with a scratch config home.
//
//  The incident question: a session switched from an OpenAI
//  model onto the Anthropic lane wedged for 90s before the stream-idle
//  watchdog fired. The suspected cause was the Anthropic OAuth. This prover
//  pins the credential path's actual observable shapes so silence can never
//  again be attributed to it without evidence:
//
//    A  PROACTIVE refresh — getAnthropicClient() refreshes an EXPIRED stored
//       token before the first request: exactly one token POST, the API
//       request carries the refreshed bearer, the turn settles.
//    B  REACTIVE refresh-on-401 — a server-rejected (unexpired) token 401s,
//       withRetry refreshes and rebuilds, the retried request carries the
//       new bearer, the turn settles. A 401 is a FAST typed error thrown
//       before any stream exists — never stream silence.
//    C  DEAD refresh token — invalid_grant refuses refresh, blanks the
//       stored refresh token, latches known-dead (no second token POST);
//       a full drive with a dead credential yields a typed API error and
//       ends — bounded, loud, no wedge.
//
//  The token endpoint is allowlist-locked (CUSTOM_OAUTH_ALLOWLIST is a
//  security contract), so its HTTP hop is intercepted at the axios adapter
//  seam IN-PROCESS — the same module instance the oauth client uses. Every
//  other leg is real: secure storage (file store under the scratch home),
//  expiry logic, single-flight lock, withRetry, streamCore, and the
//  /v1/messages wire against the loopback fixture.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-oauth-refresh-on-switch.ts
// ============================================================================
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
// The subscriber path must win: every external-token disabler absent.
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.ANTHROPIC_API_KEY
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'oauth-refresh-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_MAX_RETRIES = '2'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// --- The loopback /v1/messages fixture --------------------------------------
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

/** Bearers the fixture 401s (server-side revocation double). */
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
          // Keeps the dead-credential arm bounded: the server's own
          // retry hint, honoured by isRetryableError.
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

// Every endpoint base pinned — an unpinned base fails open to real
// credentials (the standing fixture law).
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

// --- The axios adapter seam (token endpoint + profile fetch) ----------------
type TokenGrant = { access: string; rotateRefreshTo?: string } | { invalidGrant: true }
let tokenGrant: TokenGrant = { access: 'unset' }
let tokenPosts = 0
let profileGets = 0
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
  unexpectedAxios.push(`${method.toUpperCase()} ${url}`)
  return respond(500, { error: 'unexpected axios egress in fixture' })
}

console.log('============================================================')
console.log(' oauth refresh on switch — the credential path, all shapes')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const auth = await import('../../src/utils/auth.ts')
const { CLAUDE_AI_OAUTH_SCOPES } = await import('../../src/constants/oauth.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Message = import('../../src/types/message.ts').Message

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
    scopes: [...CLAUDE_AI_OAUTH_SCOPES],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
  } as never)
  auth.clearOAuthTokenCache()
}

// ============================================================================
section('A · proactive — an EXPIRED stored token refreshes before request 1')
// ============================================================================
{
  seed({ accessToken: 'at-stale-a', refreshToken: 'rt-a', expiresAt: Date.now() - 60_000 })
  tokenGrant = { access: 'at-fresh-a' }
  const before = { posts: tokenPosts, api: apiRequests.length }
  const o = await drive()
  const mine = apiRequests.slice(before.api)
  check('subscriber path live (no env token shadowing the stored OAuth)', auth.isClaudeAISubscriber(), 'isClaudeAISubscriber()=false — seeding failed')
  check('exactly ONE token POST before the first API request', tokenPosts - before.posts === 1, `posts=${tokenPosts - before.posts}`)
  check('the API request carries the REFRESHED bearer, first try', mine.length === 1 && mine[0]?.bearer === 'at-fresh-a', `requests=${JSON.stringify(mine)}`)
  check('the turn settled end_turn with no error surfaced', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)} errors=${o.errors.length}`)
  check('the refreshed credential was persisted', auth.getClaudeAIOAuthTokens()?.accessToken === 'at-fresh-a')
}

// ============================================================================
section('B · reactive — a server-revoked (unexpired) token 401s, refresh heals the retry')
// ============================================================================
{
  seed({ accessToken: 'at-revoked-b', refreshToken: 'rt-b', expiresAt: Date.now() + 3_600_000 })
  revokedBearers.add('at-revoked-b')
  tokenGrant = { access: 'at-fresh-b', rotateRefreshTo: 'rt-b2' }
  const before = { posts: tokenPosts, api: apiRequests.length }
  const o = await drive()
  const mine = apiRequests.slice(before.api)
  check('request 1 went out with the revoked bearer and 401d (no proactive refresh — token looked fresh)', mine[0]?.bearer === 'at-revoked-b' && mine[0]?.status === 401, `requests=${JSON.stringify(mine)}`)
  check('the 401 triggered exactly ONE refresh POST', tokenPosts - before.posts === 1, `posts=${tokenPosts - before.posts}`)
  check('the RETRIED request carries the refreshed bearer and succeeds', mine.length === 2 && mine[1]?.bearer === 'at-fresh-b' && mine[1]?.status === 200, `requests=${JSON.stringify(mine)}`)
  check('the turn settled end_turn — a 401 heals, it never wedges', o.threw === undefined && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)}`)
  check('the rotated refresh token was persisted', auth.getClaudeAIOAuthTokens()?.refreshToken === 'rt-b2')
  revokedBearers.clear()
}

// ============================================================================
section('C · dead refresh token — invalid_grant is a typed, bounded refusal')
// ============================================================================
{
  // C1: the refresh path itself, driven directly through the real function.
  seed({ accessToken: 'at-stale-c', refreshToken: 'rt-dead', expiresAt: Date.now() - 60_000 })
  tokenGrant = { invalidGrant: true }
  const before = { posts: tokenPosts }
  const healed = await auth.handleOAuth401Error('at-stale-c')
  check('C1: handleOAuth401Error reports NOT healed on invalid_grant', healed === false)
  check('C1: exactly one token POST was spent', tokenPosts - before.posts === 1, `posts=${tokenPosts - before.posts}`)
  const blanked = auth.getClaudeAIOAuthTokens()
  check('C1: the dead refresh token is BLANKED on disk; the record survives', blanked !== null && blanked?.refreshToken === '', `refreshToken=${JSON.stringify(blanked?.refreshToken)}`)
  const posts2 = tokenPosts
  await auth.handleOAuth401Error('at-stale-c')
  check('C1: known-dead latch — no second token POST for the same credential', tokenPosts === posts2, `posts=${tokenPosts - posts2}`)

  // C2: the full drive with a dead credential — typed API error, bounded end.
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
