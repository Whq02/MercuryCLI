#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-account-identity.ts — CREDENTIAL-DERIVED identity
// Functional, hermetic (injected
//  creds reader + fetch):
//    · verified: live email wins and the scope's OWN snapshot HEALS in place;
//    · expired (401): distinct state carrying the labeled snapshot;
//    · offline: labeled unverified fallback — never cached (retries next);
//    · signed-out: no creds ⇒ distinct state;
//    · the stale-snapshot lie is impossible: a snapshot can never present
//      as verified.
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

const {
  resolveLiveScopeIdentity,
  healScopeIdentitySnapshot,
  _resetIdentityCacheForTesting,
} = await import('../../src/utils/accounts/accountIdentity.ts')

const dir = mkdtempSync(join(tmpdir(), 'acct-identity-'))
writeFileSync(
  join(dir, '.claude.json'),
  JSON.stringify({ oauthAccount: { accountUuid: 'stale-uuid', emailAddress: 'stale@old.example' } }),
)

const creds = { accessToken: 'tok-live', refreshToken: 'r', expiresAt: null }
const okFetch = (async () =>
  new Response(JSON.stringify({ account: { email_address: 'true@now.example', uuid: 'true-uuid' } }), {
    status: 200,
  })) as unknown as typeof fetch

try {
  console.log('── verified: live identity wins + snapshot heals ──')
  const verified = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: okFetch })
  check('state verified with the LIVE email', verified.state === 'verified' && verified.email === 'true@now.example')
  const healed = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as {
    oauthAccount: { emailAddress: string; accountUuid: string }
  }
  check(
    'the scope snapshot HEALED in place (stale lie converges on truth)',
    healed.oauthAccount.emailAddress === 'true@now.example' && healed.oauthAccount.accountUuid === 'true-uuid',
  )

  console.log('── cache: second read never refetches ──')
  let fetches = 0
  const countingFetch = (async () => {
    fetches++
    return new Response(JSON.stringify({ account: { email_address: 'x@x' } }), { status: 200 })
  }) as unknown as typeof fetch
  const again = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: countingFetch })
  check('cached verified answer (no refetch)', again.state === 'verified' && fetches === 0)

  console.log('── expired: 401 is DISTINCT and labeled ──')
  _resetIdentityCacheForTesting()
  const expiredFetch = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
  const expired = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: expiredFetch })
  check(
    'expired carries the labeled snapshot, never presents as verified',
    expired.state === 'expired' && expired.snapshotEmail === 'true@now.example',
    JSON.stringify(expired),
  )

  console.log('── offline: labeled unverified, never cached ──')
  _resetIdentityCacheForTesting()
  const downFetch = (async () => {
    throw new Error('network down')
  }) as unknown as typeof fetch
  const offline = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: downFetch })
  check(
    'offline degrades to the LABELED snapshot fallback',
    offline.state === 'unverified' && offline.email === 'true@now.example' && offline.note.length > 0,
  )
  const retried = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: okFetch })
  check('offline result was NOT cached (live retry verifies)', retried.state === 'verified')

  console.log('── signed-out: no creds is DISTINCT ──')
  _resetIdentityCacheForTesting()
  const signedOut = await resolveLiveScopeIdentity(dir, { readCreds: () => undefined, fetchImpl: okFetch })
  check('signed-out state', signedOut.state === 'signed-out')

  console.log('── heal is a merge, never a wipe ──')
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ keepMe: true, oauthAccount: { emailAddress: 'old@x', organizationName: 'Org' } }),
  )
  healScopeIdentitySnapshot(dir, { email: 'new@x', uuid: 'u2' })
  const merged = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>
  const oa = merged.oauthAccount as Record<string, unknown>
  check(
    'heal merges (sibling keys + other oauthAccount fields survive)',
    merged.keepMe === true && oa.organizationName === 'Org' && oa.emailAddress === 'new@x' && oa.accountUuid === 'u2',
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
  _resetIdentityCacheForTesting()
}

console.log(failures === 0 ? 'ACCOUNT IDENTITY: ALL GREEN' : `ACCOUNT IDENTITY: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
