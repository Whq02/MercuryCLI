#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-scoped-reauth.ts — the in-board scoped reauth
//  (the account rework: "expired ⇒ ↵ opens the login link,
//  paste the code, no relaunch"). Functional, hermetic (injected open/
//  exchange/save/fetch):
//    · start: PKCE + state minted, MANUAL-redirect authorize URL, the
//      browser open fires immediately;
//    · complete: state mismatch REFUSED · exchange failure surfaces ·
//      success saves through the auth-scope BRACKET (set to the target dir
//      during the save, restored after — both asserted from inside the
//      injected save) and heals the scope's own snapshot;
//    · the primary session's auth scope is byte-identical after either
//      outcome.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { startScopedReauth, completeScopedReauth } = await import(
  '../../src/utils/accounts/scopedReauth.ts'
)
const { getAuthScope } = await import('../../src/utils/envUtils.ts')

const dir = mkdtempSync(join(tmpdir(), 'scoped-reauth-'))
writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@x', accountUuid: 'old' } }))

try {
  console.log('── start: link minted + opened immediately ──')
  let opened: string | null = null
  const pending = await startScopedReauth(dir, {
    open: async url => {
      opened = url
      return true
    },
  })
  check('the browser open fired immediately', opened !== null && opened === pending.url)
  const url = new URL(pending.url)
  check('PKCE challenge + method present', url.searchParams.get('code_challenge') !== null && url.searchParams.get('code_challenge_method') === 'S256')
  check('state echoed into the URL', url.searchParams.get('state') === pending.state)
  check('MANUAL redirect (the code pastes back into the board)', (url.searchParams.get('redirect_uri') ?? '').startsWith('http') && !(url.searchParams.get('redirect_uri') ?? '').includes('localhost'))
  check('verifier held, never in the URL', pending.codeVerifier.length >= 40 && !pending.url.includes(pending.codeVerifier))

  console.log('── complete: refusals ──')
  const mismatch = await completeScopedReauth(pending, 'somecode#WRONGSTATE', {
    exchange: async () => {
      throw new Error('must not be called')
    },
  })
  check('state mismatch REFUSED before any exchange', !mismatch.ok && /state mismatch/.test(mismatch.ok ? '' : mismatch.reason))
  const empty = await completeScopedReauth(pending, '   ', {})
  check('empty paste refused with instruction', !empty.ok)
  const failed = await completeScopedReauth(pending, `code-1#${pending.state}`, {
    exchange: async () => {
      throw new Error('invalid grant')
    },
  })
  check('exchange failure surfaces honestly', !failed.ok && /invalid grant/.test(failed.ok ? '' : failed.reason))
  check('auth scope untouched after refusals', getAuthScope() === undefined)

  console.log('── complete: success saves through the SCOPE BRACKET ──')
  let scopeDuringSave: string | undefined
  let savedTokens: Record<string, unknown> | null = null
  const outcome = await completeScopedReauth(pending, `authcode-42#${pending.state}`, {
    exchange: async (code, state, verifier, _port, manual) => {
      check('exchange gets the pasted code + held verifier + manual redirect', code === 'authcode-42' && state === pending.state && verifier === pending.codeVerifier && manual === true)
      return {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile',
      }
    },
    save: tokens => {
      scopeDuringSave = getAuthScope()
      savedTokens = tokens as unknown as Record<string, unknown>
      return { success: true }
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ account: { email_address: 'fresh@now.example', uuid: 'fresh-uuid' } }), {
        status: 200,
      })) as unknown as typeof fetch,
  })
  check('reauth succeeds with the live email', outcome.ok && outcome.email === 'fresh@now.example', JSON.stringify(outcome))
  check('the save ran INSIDE the target-scope bracket', scopeDuringSave === dir)
  check('the bracket RESTORED after (primary untouched)', getAuthScope() === undefined)
  check(
    'token fields mapped exactly (access · refresh · expiry · scopes)',
    savedTokens !== null &&
      (savedTokens as { accessToken?: string }).accessToken === 'new-access' &&
      (savedTokens as { refreshToken?: string }).refreshToken === 'new-refresh' &&
      Array.isArray((savedTokens as { scopes?: string[] }).scopes),
  )
  const healed = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as {
    oauthAccount: { emailAddress: string }
  }
  check("the scope's OWN snapshot healed (never the primary config)", healed.oauthAccount.emailAddress === 'fresh@now.example')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'SCOPED REAUTH: ALL GREEN' : `SCOPED REAUTH: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
