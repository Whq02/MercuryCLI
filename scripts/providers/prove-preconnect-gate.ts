#!/usr/bin/env bun
// ============================================================================
//  scripts/providers/prove-preconnect-gate.ts — the boot warm-up targets
//  the Anthropic origin ONLY for a session that runs on one (a plain interactive boot opened one
//  connect toward api.anthropic.com BEFORE the board mounted, on a scratch
//  home with no credential — the provider-neutrality posture's one
//  phone-home smell).
//
//  THE LAW: the warm-up fires when the session's default lane is Anthropic
//  AND an Anthropic credential exists; a sovereign home — a non-Anthropic
//  default (the operator's OpenRouter free tier in settings.model) or no
//  Anthropic credential at all — opens nothing. The gate reads the same
//  owners the session's admission reads (the routing law · the presence
// owner). THE UNION (the fold): the performer takes the call
//  site's credential fact — preconnectAnthropicApi({ credentialed }) — and
//  decidePreconnect skips signed-out ahead of the transport tests; this
//  prover drives the composed pair through the call site's own shape. The
//  zero-arg spelling died with the union (TypeError on opts.credentialed,
//  past the latch, every leg red) and tsconfig covers src/ only, so the one
//  typecheck could never see it — the verifier lane re-cut it.
//
//    §1 a keyless home on the Anthropic default: NO request reaches the
//       origin (base: one HEAD per boot);
//    §2 a home with an Anthropic subscription credential on the Anthropic
//       default: exactly one HEAD (the warm-up still serves its purpose);
//    §3 a home whose settings.model names an OpenRouter id (and holds an
//       OpenRouter key and an Anthropic credential): NO request — the
//       session's first request goes elsewhere;
//    §4 the proxy/socket/cert skips stay ahead of the gate (a presence
//       test, unchanged).
//
//  POISON (recorded): against the base apiPreconnect the §1 and §3 legs
//  each observe one HEAD.
//
//  Hermetic: a loopback listener stands in for the origin (ANTHROPIC_BASE_URL
//  pinned), the file credential plane on a scratch home, every proxy and
//  credential env cleared. Run:
//    ~/.bun/bin/bun run scripts/providers/prove-preconnect-gate.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' api preconnect — warms the Anthropic origin only for an Anthropic session')
console.log('============================================================')

// ── hermetic ground ─────────────────────────────────────────────────────────
for (const key of [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'ANTHROPIC_UNIX_SOCKET',
  'MERCURY_CLIENT_CERT',
  'MERCURY_CLIENT_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
const scratch = mkdtempSync(join(tmpdir(), 'prove-preconnect-gate-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1/api/v1'

// The origin stand-in: counts every request it sees.
const seen: Array<{ method: string; url: string }> = []
const origin = createServer((req, res) => {
  seen.push({ method: req.method ?? '', url: req.url ?? '' })
  res.writeHead(200)
  res.end()
})
const port = await new Promise<number>(resolve => {
  origin.listen(0, '127.0.0.1', () => {
    const address = origin.address()
    resolve(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const preconnect = await import('../../src/utils/apiPreconnect.js')

const { hasFirstPartyCredential, clearOAuthTokenCache } = await import('../../src/utils/auth.js')

/** Drive through the call site's own shape (main.tsx passes the credential
 *  fact); an explicit `credentialed` isolates the route-and-credential gate
 *  from the signed-out gate. */
async function drive(credentialed?: boolean): Promise<number> {
  const before = seen.length
  preconnect.__resetPreconnectLatchForTest()
  preconnect.preconnectAnthropicApi({ credentialed: credentialed ?? hasFirstPartyCredential() })
  // A loopback HEAD lands within milliseconds; the wait is generous so an
  // absent request is an absence, not a race.
  await sleep(600)
  return seen.length - before
}

// ── §1 keyless, the Anthropic default ───────────────────────────────────────
section('§1 a keyless home opens no connect toward the origin')
{
  const requests = await drive()
  check('no request reached the origin (base: one HEAD per boot)', requests === 0, `${requests} request(s): ${JSON.stringify(seen)}`)
  // The union's second gate alone: a caller VOUCHING a credential on a
  // keyless home still opens nothing — the route-and-credential gate does
  // not lean on the signed-out skip.
  const vouched = await drive(true)
  check('…and a vouched-credential call still opens nothing on a keyless home', vouched === 0, `${vouched} request(s)`)
}

// ── §2 an Anthropic credential, the Anthropic default ──────────────────────
section('§2 an Anthropic subscription credential on the Anthropic default warms the origin once')
{
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token-000000000001',
        refreshToken: 'fixture-refresh-token-00000000001',
        expiresAt: 4102444800000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: null,
      },
    }),
  )
  // The OAuth token read is memoized for the process lifetime (auth.ts
  // getClaudeAIOAuthTokens) — correct on a real boot, where one process sees
  // one credential state. This prover CHANGES the credential plane between
  // legs, so it performs the same clear every production credential
  // transition (login/logout/refresh) performs. Without it §1's keyless read
  // stands and this leg observes 0 requests (the inherited red polish named).
  clearOAuthTokenCache()
  const requests = await drive()
  check('exactly one request reached the origin', requests === 1, `${requests} request(s)`)
  check('…and it was the HEAD warm-up', seen.at(-1)?.method === 'HEAD', JSON.stringify(seen.at(-1)))
}

// ── §3 the sovereign default: settings.model names another family ───────────
section("§3 a session whose default model rides OpenRouter opens no connect (the operator's own home shape)")
{
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-preconnect'
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'openrouter/nvidia/nemotron-nano-9b-v2:free' }))
  // The settings read is cached per process (a real boot reads once);
  // the legs above ran before the file existed, so the cache re-reads.
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  resetSettingsCache()
  const { getMainLoopModel } = await import('../../src/utils/model/model.js')
  const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.js')
  check('premise: the resolved main-loop model routes to openrouter', declaredRouteOf(getMainLoopModel()) === 'openrouter', getMainLoopModel())
  const requests = await drive()
  check('no request reached the Anthropic origin (base: one HEAD regardless of the lane)', requests === 0, `${requests} request(s)`)
  delete process.env.OPENROUTER_API_KEY
  rmSync(join(home, 'settings.json'), { force: true })
  resetSettingsCache()
}

// ── §4 the transport skips stay ahead of the gate ───────────────────────────
section('§4 a proxy presence still skips before any gate read (unchanged law)')
{
  process.env.HTTPS_PROXY = ''
  const requests = await drive()
  check('a present-but-empty proxy variable skips the warm-up (presence, not truthiness)', requests === 0, `${requests} request(s)`)
  delete process.env.HTTPS_PROXY
}

await new Promise<void>(resolve => origin.close(() => resolve()))
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(failures === 0 ? '\n✅ prove-preconnect-gate — all checks pass' : `\n❌ prove-preconnect-gate — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
