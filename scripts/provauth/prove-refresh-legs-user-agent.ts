#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-refresh-legs-user-agent.ts — every OAuth REFRESH
//  leg works under the product-true agent, and presents it.
//
//  The user-agent retirement (utils/http.ts) made every provider wire spell
//  `mercury/<version>`; the auxiliary token endpoints must not compose their
//  own agent behind that — Anthropic's token leg rode axios's library
//  default. Fixture-driven, no live logins: each leg's
//  request is captured at its injection seam and its response decoded by
//  the real refresh code.
//
//   §1 OpenAI subscription refresh (currentSubscriptionTokens, forced):
//      the token POST presents mercury/<version>; the rotated set persists
//   §2 Gemini OAuth refresh (currentGeminiTokens, forced): same law
//   §3 Moonshot/Kimi refresh (refreshMoonshotTokens): same law
//   §4 Anthropic OAuth refresh (refreshOAuthToken): the axios token POST
//      presents mercury/<version> (never axios/<lib>), and the refreshed
//      credential decodes
//   §5 no auxiliary surface composes its own agent string (structural:
//      the extension source fetch and the Hugging Face token legs)
//
//  Run: ~/.bun/bin/bun run scripts/provauth/prove-refresh-legs-user-agent.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

for (const key of [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MOONSHOT_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-refresh-ua-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://fixture.invalid/openai/auth'
process.env.MERCURY_OPENAI_API_BASE = 'https://fixture.invalid/openai/v1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'https://fixture.invalid/openai/chatgpt'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://fixture.invalid/gemini/oauth/token'
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = 'https://fixture.invalid/gemini/oauth/auth'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/gemini/v1beta'
process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID = 'fixture-gemini-client'
process.env.MERCURY_MOONSHOT_OAUTH_BASE = 'https://fixture.invalid/moonshot/oauth'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://fixture.invalid/moonshot/v1'

const ROOT = join(import.meta.dir, '..', '..')
const b64url = (s: string): string => Buffer.from(s).toString('base64url')
const jwt = (payload: Record<string, unknown>): string => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`
const futureExp = Math.floor(Date.now() / 1000) + 3600

type Captured = { url: string; userAgent: string; method: string }
function capturing(body: unknown, into: Captured[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    into.push({ url: String(url), userAgent: headers['user-agent'] ?? headers['User-Agent'] ?? '', method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}
const productAgent = (ua: string): boolean => /^mercury\/1\.0\.0/.test(ua) && !/axios|claude-cli|node-fetch|undici/i.test(ua)

// ============================================================================
section('§1 OpenAI subscription refresh presents the product agent')
// ============================================================================
{
  const openai = await import('../../src/services/providers/openai/openaiAccounts.ts')
  const path = openai.openaiAuthPathForDisplay()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tokens: { idToken: jwt({}), accessToken: jwt({ exp: 1 }), refreshToken: 'rt-openai-old', accessTokenExpiresAtMs: 1 },
    }),
  )
  const seen: Captured[] = []
  const fresh = await openai.currentSubscriptionTokens({
    force: true,
    fetchImpl: capturing({ id_token: jwt({}), access_token: jwt({ exp: futureExp }), refresh_token: 'rt-openai-new' }, seen),
  })
  check('one token POST to the pinned issuer', seen.length === 1 && seen[0]!.method === 'POST' && seen[0]!.url === 'https://fixture.invalid/openai/auth/oauth/token', JSON.stringify(seen))
  check('the POST presents mercury/<version>', productAgent(seen[0]?.userAgent ?? ''), seen[0]?.userAgent)
  check('the rotated set decodes and persists', fresh?.refreshToken === 'rt-openai-new' && openai.subscriptionConnected())
}

// ============================================================================
section('§2 Gemini OAuth refresh presents the product agent')
// ============================================================================
{
  const gemini = await import('../../src/services/providers/gemini/geminiAccounts.ts')
  const path = gemini.geminiAuthPathForDisplay()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, tokens: { accessToken: 'ga-old', refreshToken: 'grt', accessTokenExpiresAtMs: 1 } }))
  const seen: Captured[] = []
  const fresh = await gemini.currentGeminiTokens({ force: true, fetchImpl: capturing({ access_token: 'ga-new', expires_in: 3600 }, seen) })
  check('one token POST to the pinned Google token base', seen.length === 1 && seen[0]!.method === 'POST' && seen[0]!.url === 'https://fixture.invalid/gemini/oauth/token', JSON.stringify(seen))
  check('the POST presents mercury/<version>', productAgent(seen[0]?.userAgent ?? ''), seen[0]?.userAgent)
  check('the refreshed set decodes (Google refresh tokens do not rotate)', fresh?.accessToken === 'ga-new' && fresh.refreshToken === 'grt')
}

// ============================================================================
section('§3 Moonshot/Kimi refresh presents the product agent')
// ============================================================================
{
  const moonshot = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
  moonshot.writeMoonshotTokens({ accessToken: 'ka-old', refreshToken: 'krt', accessTokenExpiresAtMs: 1 }, 'global')
  const seen: Captured[] = []
  const fresh = await moonshot.refreshMoonshotTokens({ fetchImpl: capturing({ access_token: 'ka-new', refresh_token: 'krt2', expires_in: 3600 }, seen) })
  check('one token POST to the pinned Moonshot OAuth base', seen.length === 1 && seen[0]!.method === 'POST' && seen[0]!.url === 'https://fixture.invalid/moonshot/oauth/api/oauth/token', JSON.stringify(seen))
  check('the POST presents mercury/<version>', productAgent(seen[0]?.userAgent ?? ''), seen[0]?.userAgent)
  check('the rotated set decodes and persists', fresh?.accessToken === 'ka-new' && moonshot.moonshotStoredTokens()?.refreshToken === 'krt2')
}

// ============================================================================
section('§4 Anthropic OAuth refresh presents the product agent (axios leg)')
// ============================================================================
{
  const posts: Array<{ url: string; userAgent: string }> = []
  axios.defaults.adapter = async config => {
    const url = String(config.url ?? '')
    const method = (config.method ?? 'get').toLowerCase()
    const headers = config.headers as unknown as { get?: (n: string) => unknown; [k: string]: unknown }
    const ua = String(headers?.get?.('User-Agent') ?? headers?.['User-Agent'] ?? headers?.['user-agent'] ?? '')
    if (method === 'post' && url.endsWith('/v1/oauth/token')) {
      posts.push({ url, userAgent: ua })
      return {
        status: 200,
        statusText: 'OK',
        data: { access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600, scope: 'user:inference user:profile' },
        headers: {},
        config,
      } as never
    }
    // The profile leg after a refresh: unreachable here ⇒ the client's own
    // null-profile arm (the refreshed credential still returns).
    throw new axios.AxiosError('fixture: no profile endpoint', 'ECONNREFUSED', config as never)
  }
  const { refreshOAuthToken } = await import('../../src/services/oauth/client.ts')
  const tokens = await refreshOAuthToken('rt-anthropic-old')
  check('one token POST to the Anthropic token URL', posts.length === 1 && /\/v1\/oauth\/token$/.test(posts[0]!.url), JSON.stringify(posts))
  check('the POST presents mercury/<version> — never the axios library agent', productAgent(posts[0]?.userAgent ?? ''), posts[0]?.userAgent)
  check('the refreshed credential decodes', tokens.accessToken === 'at-fresh' && tokens.refreshToken === 'rt-fresh' && tokens.scopes.includes('user:inference'))
}

// ============================================================================
section('§5 no auxiliary surface composes its own agent string (structural)')
// ============================================================================
{
  const sources = readFileSync(join(ROOT, 'src/extensions/sources.ts'), 'utf8')
  check('the extension source (archive) fetch presents the product identity', /headers: \{ 'user-agent': getMercuryUserAgent\(\) \}/.test(sources))
  const hf = readFileSync(join(ROOT, 'src/services/providers/huggingface/huggingfaceAccounts.ts'), 'utf8')
  check('the Hugging Face token legs ride getUserAgent()', (hf.match(/'user-agent': getUserAgent\(\)/g) ?? []).length >= 2)
  const oauth = readFileSync(join(ROOT, 'src/services/oauth/client.ts'), 'utf8')
  check('every Anthropic OAuth axios leg (exchange · refresh · roles · key) names the product agent', (oauth.match(/'User-Agent': getMercuryUserAgent\(\)/g) ?? []).length === 4)
  const userAgent = readFileSync(join(ROOT, 'src/utils/userAgent.ts'), 'utf8')
  check('the Anthropic client UA IS the product identity (one owner)', /return getMercuryUserAgent\(\)/.test(userAgent))
  // Seen live on a loopback fixture: the boot-time HEAD
  // warm-up of the API origin presented undici's library agent.
  const preconnect = readFileSync(join(ROOT, 'src/utils/apiPreconnect.ts'), 'utf8')
  check('the API-origin warm-up HEAD presents the product agent', /'user-agent': getMercuryUserAgent\(\)/.test(preconnect))
  check('the source fetch reads the agent per request, never at module load (the version macro is a build define)', !/^const [A-Z_]+ = getMercuryUserAgent\(\)/m.test(sources))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
