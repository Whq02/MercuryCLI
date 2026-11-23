#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
} = await import('../../src/models/sign-in/account-ledger/accountIdentity.ts')
const { scopeIdentityFile } = await import('../../src/models/sign-in/account-ledger/scopeScan.ts')
const { getOauthConfig } = await import('../../src/models/sign-in/oauth/oauth.ts')

const dir = mkdtempSync(join(tmpdir(), 'acct-identity-'))
writeFileSync(
  join(dir, '.mercury.json'),
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
  check('state verified with the LIVE email', verified.state === 'verified' && verified.email === 'true@now.example', `${JSON.stringify(verified)}; resolveUncached in src/models/sign-in/account-ledger/accountIdentity.ts must return the email from the /api/oauth/profile answer`)
  const healed = JSON.parse(readFileSync(join(dir, '.mercury.json'), 'utf8')) as {
    oauthAccount: { emailAddress: string; accountUuid: string }
  }
  check(
    'the scope snapshot HEALED in place (stale lie converges on truth)',
    healed.oauthAccount.emailAddress === 'true@now.example' && healed.oauthAccount.accountUuid === 'true-uuid',
    `${JSON.stringify(healed)}; a verified read must call healScopeIdentitySnapshot in src/models/sign-in/account-ledger/accountIdentity.ts`,
  )

  console.log('── cache: second read never refetches ──')
  let fetches = 0
  const countingFetch = (async () => {
    fetches++
    return new Response(JSON.stringify({ account: { email_address: 'x@x' } }), { status: 200 })
  }) as unknown as typeof fetch
  const again = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: countingFetch })
  check('cached verified answer (no refetch)', again.state === 'verified' && fetches === 0, `state=${again.state} fetches=${fetches}; resolveLiveScopeIdentity in src/models/sign-in/account-ledger/accountIdentity.ts must answer a verified result from its cache`)

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
    `${JSON.stringify(offline)}; the catch branch of resolveUncached in src/models/sign-in/account-ledger/accountIdentity.ts must return state unverified with the snapshot email and a note`,
  )
  const retried = await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: okFetch })
  check('offline result was NOT cached (live retry verifies)', retried.state === 'verified', `state=${retried.state}; resolveLiveScopeIdentity in src/models/sign-in/account-ledger/accountIdentity.ts must not cache an unverified result`)

  console.log('── signed-out: no creds is DISTINCT ──')
  _resetIdentityCacheForTesting()
  const signedOut = await resolveLiveScopeIdentity(dir, { readCreds: () => undefined, fetchImpl: okFetch })
  check('signed-out state', signedOut.state === 'signed-out', `${JSON.stringify(signedOut)}; resolveUncached in src/models/sign-in/account-ledger/accountIdentity.ts must return signed-out when readCreds gives no token`)

  console.log('── the profile read rides the base the usage read rides ──')
  _resetIdentityCacheForTesting()
  const seen: string[] = []
  const recordingFetch = (async (url: string) => {
    seen.push(url)
    return new Response(JSON.stringify({ account: { email_address: 'true@now.example', uuid: 'true-uuid' } }), { status: 200 })
  }) as unknown as typeof fetch
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1/gateway'
  await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: recordingFetch })
  check('with ANTHROPIC_BASE_URL set the profile is read under that base', seen[0] === 'http://127.0.0.1:1/gateway/api/oauth/profile', seen.join(', '))
  delete process.env.ANTHROPIC_BASE_URL
  _resetIdentityCacheForTesting()
  seen.length = 0
  await resolveLiveScopeIdentity(dir, { readCreds: () => creds, fetchImpl: recordingFetch })
  check("without it the OAuth home is the base, the usage read's own fallback", seen[0] === `${getOauthConfig().BASE_API_URL}/api/oauth/profile`, seen.join(', '))

  console.log('── heal is a merge, never a wipe ──')
  writeFileSync(
    join(dir, '.mercury.json'),
    JSON.stringify({ keepMe: true, oauthAccount: { emailAddress: 'old@x', organizationName: 'Org' } }),
  )
  healScopeIdentitySnapshot(dir, { email: 'new@x', uuid: 'u2' })
  const merged = JSON.parse(readFileSync(join(dir, '.mercury.json'), 'utf8')) as Record<string, unknown>
  const oa = merged.oauthAccount as Record<string, unknown>
  check(
    'heal merges (sibling keys + other oauthAccount fields survive)',
    merged.keepMe === true && oa.organizationName === 'Org' && oa.emailAddress === 'new@x' && oa.accountUuid === 'u2',
    `${JSON.stringify(merged)}; healScopeIdentitySnapshot in src/models/sign-in/account-ledger/accountIdentity.ts must spread the prior file and prior oauthAccount before writing the new email and uuid`,
  )

  console.log('── a snapshot left under another tool\'s basename in a scope dir is never adopted ──')
  const adoptDir = mkdtempSync(join(tmpdir(), 'acct-adopt-'))
  const snapshotBytes = JSON.stringify({ oauthAccount: { accountUuid: 'adopt-uuid', emailAddress: 'adopt@x' } })
  writeFileSync(join(adoptDir, '.claude.json'), snapshotBytes)
  const target = scopeIdentityFile(adoptDir)
  check('the identity file is the scope config file', target === join(adoptDir, '.mercury.json'), `target=${target}; scopeIdentityFile in src/models/sign-in/account-ledger/scopeScan.ts must return the scope dir's .mercury.json (globalConfigFileIn)`)
  check('the other tool\'s snapshot is never adopted: no identity file appears', !existsSync(target), `${target} exists; nothing in src/models/sign-in/account-ledger/ may copy another tool's snapshot into the scope's identity file`)
  check('the other tool\'s file is left as it is', readFileSync(join(adoptDir, '.claude.json'), 'utf8') === snapshotBytes, `${join(adoptDir, '.claude.json')} changed; nothing in src/models/sign-in/account-ledger/ may rewrite another tool's snapshot`)
  const foreign = join(adoptDir, '.claude-other')
  mkdirSync(foreign)
  writeFileSync(join(foreign, '.claude.json'), snapshotBytes)
  scopeIdentityFile(foreign)
  check('another harness\'s home is never written', !existsSync(join(foreign, '.mercury.json')), `${join(foreign, '.mercury.json')} was written; healScopeIdentitySnapshot in src/models/sign-in/account-ledger/accountIdentity.ts must skip an isForeignHarnessDir dir`)
  rmSync(adoptDir, { recursive: true, force: true })
  console.log('── every mainstream harness home reads as another tool\'s, never Mercury\'s ──')
  const { isForeignHarnessDir } = await import('../../src/models/sign-in/account-ledger/scopeScan.ts')
  const foreignHomes = ['.codex', '.gemini', '.copilot', '.cursor', '.kiro', '.cline', '.continue', '.qwen', '.pi', '.pi/agent', '.omp', '.omp/agent', '.config/opencode', '.config/amp', '.config/goose']
  check('the harness homes read foreign', foreignHomes.every(h => isForeignHarnessDir(join('/proof-home', h))), `not foreign: ${foreignHomes.filter(h => !isForeignHarnessDir(join('/proof-home', h))).join(', ')}; add the home to FOREIGN_HARNESS_HOMES or FOREIGN_HARNESS_CONFIG_HOMES in src/models/sign-in/account-ledger/scopeScan.ts`)
  check('a trailing slash changes nothing', isForeignHarnessDir('/proof-home/.codex/'), 'isForeignHarnessDir in src/models/sign-in/account-ledger/scopeScan.ts must strip trailing slashes before comparing')
  check('Mercury\'s own homes and other folders read as Mercury\'s', ['.mercury', '.mercury-work', '.config/mercury', '.config/other', 'codex'].every(h => !isForeignHarnessDir(join('/proof-home', h))), `read as foreign: ${['.mercury', '.mercury-work', '.config/mercury', '.config/other', 'codex'].filter(h => isForeignHarnessDir(join('/proof-home', h))).join(', ')}; narrow FOREIGN_HARNESS_HOMES or FOREIGN_HARNESS_CONFIG_HOMES in src/models/sign-in/account-ledger/scopeScan.ts`)
} finally {
  rmSync(dir, { recursive: true, force: true })
  _resetIdentityCacheForTesting()
}

console.log(failures === 0 ? 'ACCOUNT IDENTITY: ALL GREEN' : `ACCOUNT IDENTITY: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
