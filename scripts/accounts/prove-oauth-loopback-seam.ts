#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const oauth = await import('../../src/constants/oauth.ts')
const env = await import('../../src/utils/env.ts')

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
const withCustom = <T,>(url: string | undefined, fn: () => T): T => {
  const before = process.env.MERCURY_ANTHROPIC_OAUTH_BASE
  if (url === undefined) delete process.env.MERCURY_ANTHROPIC_OAUTH_BASE
  else process.env.MERCURY_ANTHROPIC_OAUTH_BASE = url
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.MERCURY_ANTHROPIC_OAUTH_BASE
    else process.env.MERCURY_ANTHROPIC_OAUTH_BASE = before
  }
}
const PRODUCTION_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

section('§1 the loopback predicate')
check('127.0.0.1 on any port is loopback', oauth.isLoopbackOauthOrigin('http://127.0.0.1:5') && oauth.isLoopbackOauthOrigin('http://127.0.0.1:65000/'))
check('localhost and ::1 are loopback', oauth.isLoopbackOauthOrigin('http://localhost:9') && oauth.isLoopbackOauthOrigin('http://[::1]:7'))
check('a real host is not, nor a non-http scheme, nor garbage', !oauth.isLoopbackOauthOrigin('https://example.com') && !oauth.isLoopbackOauthOrigin('ftp://127.0.0.1:1') && !oauth.isLoopbackOauthOrigin('not a url') && !oauth.isLoopbackOauthOrigin('https://127.0.0.1.example.com'))

section('§2 the record under a loopback pin')
{
  const base = 'http://127.0.0.1:65000'
  const record = withCustom(base, () => oauth.getOauthConfig())
  check('the token endpoint rides the pinned loopback base', record.TOKEN_URL === `${base}/v1/oauth/token`, record.TOKEN_URL)
  check('the api base, the authorize doors and the roles endpoint ride it too', record.BASE_API_URL === base && record.SUBSCRIPTION_AUTHORIZE_URL.startsWith(base) && record.ROLES_URL.startsWith(base), JSON.stringify({ base: record.BASE_API_URL, roles: record.ROLES_URL }))
  check('a trailing slash is trimmed, never doubled', withCustom(`${base}/`, () => oauth.getOauthConfig()).TOKEN_URL === `${base}/v1/oauth/token`)
}

section('§3 any other origin is not read')
check('a foreign https host leaves the production record standing', withCustom('https://evil.example', () => oauth.getOauthConfig()).TOKEN_URL === PRODUCTION_TOKEN_URL)
check('a host that only LOOKS loopback is not read', withCustom('https://127.0.0.1.example.com', () => oauth.getOauthConfig()).TOKEN_URL === PRODUCTION_TOKEN_URL)
check('a non-http scheme is not read', withCustom('ftp://127.0.0.1:1', () => oauth.getOauthConfig()).TOKEN_URL === PRODUCTION_TOKEN_URL)
check('no pin: the production record', withCustom(undefined, () => oauth.getOauthConfig()).TOKEN_URL === PRODUCTION_TOKEN_URL)

section('§4 the files are the same under every pin')
check('the record carries no file suffix field', !('OAUTH_FILE_SUFFIX' in withCustom('http://127.0.0.1:65000', () => oauth.getOauthConfig())))
check('the global-config file is the one spelling, whatever the pin', withCustom('http://127.0.0.1:65000', () => env.globalConfigFileIn('/proof-home')) === '/proof-home/.mercury.json' && withCustom('https://evil.example', () => env.globalConfigFileIn('/proof-home')) === '/proof-home/.mercury.json')

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
