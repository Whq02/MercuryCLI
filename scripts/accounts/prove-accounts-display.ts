#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeScopeAuth,
  readScopeIdentity,
} from '../../src/models/sign-in/account-ledger/scopeScan.js'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let fail = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) fail++
}
const id = (uuid: string, email: string): string =>
  JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } })

console.log('prove-accounts-display — available accounts, deduped, honestly resolved')

const home = mkdtempSync(join(tmpdir(), 'accounts-display-'))
process.env.MERCURY_CONFIG_DIR = home
try {
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.claude-account-b'), { recursive: true })
  writeFileSync(join(home, '.claude', '.mercury.json'), id('uuid-user-a', 'user-a@example.com'))
  writeFileSync(join(home, '.claude.json'), id('uuid-user-b', 'user-b@example.com'))
  writeFileSync(join(home, '.claude-account-b', '.mercury.json'), id('uuid-user-b', 'user-b@example.com'))
  const stored = { storedLogin: () => true }
  const absent = { storedLogin: () => false }

  console.log('\n── probeScopeAuth: the dir-scoped snapshot is the identity source; the STORE is the sign-in')
  const foreign = probeScopeAuth(join(home, '.claude'), stored)
  check("a stored login + its DIR-SCOPED snapshot ⇒ signed in, the snapshot's identity", foreign.authed && foreign.uuid === 'uuid-user-a', JSON.stringify(foreign), 'fix probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts so a stored login plus the dir-scoped snapshot yields authed and the snapshot uuid')
  check('email carried', foreign.email === 'user-a@example.com', '', 'fix probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts to carry the snapshot email through (readScopeIdentity)')
  const outlived = probeScopeAuth(join(home, '.claude'), absent)
  check('a snapshot with NO stored login ⇒ SIGNED OUT, the identity still labelled (never a login)',
    !outlived.authed && outlived.uuid === 'uuid-user-a' && outlived.email === 'user-a@example.com', JSON.stringify(outlived), 'fix probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts so authed follows the stored login only, while uuid and email still come from the snapshot')

  console.log('\n── no top-level fallback: another harness\'s rewritable file never answers')
  rmSync(join(home, '.claude', '.mercury.json'))
  const fell = probeScopeAuth(join(home, '.claude'), absent)
  check('snapshot missing ⇒ no identity, signed out (the top-level file is never consulted)', !fell.authed && fell.uuid === undefined && fell.email === undefined, JSON.stringify(fell), 'fix probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts to return no identity when the dir-scoped snapshot is missing and never read the top-level file')
  const loginOnly = probeScopeAuth(join(home, '.claude'), stored)
  check('a stored login with no snapshot ⇒ signed in, identity unknown (never the top-level file)', loginOnly.authed && loginOnly.uuid === undefined && loginOnly.email === undefined, JSON.stringify(loginOnly), 'fix probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts so a stored login with no snapshot is authed with no uuid or email')
  writeFileSync(join(home, '.claude', '.mercury.json'), '{not json')
  const malformed = probeScopeAuth(join(home, '.claude'), absent)
  check('malformed snapshot ⇒ no identity (a state, not a crash; never the top-level file)', !malformed.authed && malformed.uuid === undefined, '', 'fix readScopeIdentity in src/models/sign-in/account-ledger/scopeScan.ts to treat a malformed snapshot as no identity instead of throwing or falling back')
  writeFileSync(join(home, '.claude', '.mercury.json'), id('uuid-user-a', 'user-a@example.com'))

  console.log("\n── the default store read: the scope's OWN credential store, in isolation")
  mkdirSync(join(home, '.claude-account-c'), { recursive: true })
  writeFileSync(join(home, '.claude-account-c', '.credentials.json'), '{}')
  const emptyStore = probeScopeAuth(join(home, '.claude-account-c'))
  check('a credential file holding no claude.ai login is NOT a sign-in (the file-presence heuristic is dead)', !emptyStore.authed && emptyStore.uuid === undefined, JSON.stringify(emptyStore), 'fix probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts so a credential file with no claude.ai login is not a sign-in')
  writeFileSync(
    join(home, '.claude-account-c', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token-000000000001',
        refreshToken: 'fixture-refresh-token-00000000001',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: null,
      },
    }),
  )
  const storedOnly = probeScopeAuth(join(home, '.claude-account-c'))
  check('a stored claude.ai login reads signed in through the audited scoped reader (no uuid without a snapshot)', storedOnly.authed && storedOnly.uuid === undefined, JSON.stringify(storedOnly), 'fix the default store read of probeScopeAuth in src/models/sign-in/account-ledger/scopeScan.ts so a stored claude.ai login reads signed in with no uuid when there is no snapshot')

  check('readScopeIdentity: absent file ⇒ {}', readScopeIdentity(join(home, 'nope.json')).uuid === undefined, '', 'fix readScopeIdentity in src/models/sign-in/account-ledger/scopeScan.ts to return an empty identity when the file is absent')

} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(fail === 0 ? '\n✅ prove-accounts-display: ALL PASS' : `\n❌ prove-accounts-display: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
