#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-accounts-display.ts — task #10: the /accounts board
//  shows the AVAILABLE ACCOUNTS, deduped by identity, with the foreign scope
//  resolved the way the harness itself resolves config.
//
//  The bug class: the foreign-home row read the TOP-LEVEL ~/.claude.json (rewritten
//  by whichever harness wrote it last) — duplicating that account while the
//  identity actually signed into ~/.claude/.claude.json never surfaced.
//
//  BEHAVIORAL half — the pure scopeScan helpers against a scratch home
//  mirroring the live shape: the snapshot is the IDENTITY source, the
//  scope's credential STORE is the sign-in (a snapshot that outlived its
//  credential reads signed out with its identity labelled — never a login).
//  STRUCTURAL half — the single-scope universe
//  station roster, no dedupe law, no switching machinery)
//  and the board's honest wiring over it.
// ============================================================================
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeScopeAuth,
  readScopeIdentity,
} from '../../src/utils/accounts/scopeScan.js'

process.env.NODE_ENV = 'test'
// The default store read runs in isolation on the scope's own file store —
// never a keychain, never the real home.
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) fail++
}
const id = (uuid: string, email: string): string =>
  JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } })

console.log('prove-accounts-display — available accounts, deduped, honestly resolved')

const home = mkdtempSync(join(tmpdir(), 'accounts-display-'))
process.env.MERCURY_CONFIG_DIR = home
try {
  // The live shape: ~/.claude/.claude.json = user-a; top-level ~/.claude.json =
  // raverner (a bare stamp rewrote it); ~/.claude-account-b/.claude.json = raverner.
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(home, '.claude-account-b'), { recursive: true })
  writeFileSync(join(home, '.claude', '.claude.json'), id('uuid-user-a', 'user-a@example.com'))
  writeFileSync(join(home, '.claude.json'), id('uuid-raverner', 'raverner.gaming@gmail.com'))
  writeFileSync(join(home, '.claude-account-b', '.claude.json'), id('uuid-raverner', 'raverner.gaming@gmail.com'))
  const stored = { storedLogin: () => true }
  const absent = { storedLogin: () => false }

  console.log('\n── probeScopeAuth: the dir-scoped snapshot is the identity source; the STORE is the sign-in')
  const foreign = probeScopeAuth(join(home, '.claude'), stored)
  check("a stored login + its DIR-SCOPED snapshot ⇒ signed in, the snapshot's identity", foreign.authed && foreign.uuid === 'uuid-user-a', JSON.stringify(foreign))
  check('email carried', foreign.email === 'user-a@example.com')
  const outlived = probeScopeAuth(join(home, '.claude'), absent)
  check('a snapshot with NO stored login ⇒ SIGNED OUT, the identity still labelled (never a login)',
    !outlived.authed && outlived.uuid === 'uuid-user-a' && outlived.email === 'user-a@example.com', JSON.stringify(outlived))

  console.log('\n── no top-level fallback: another harness\'s rewritable file never answers')
  rmSync(join(home, '.claude', '.claude.json'))
  const fell = probeScopeAuth(join(home, '.claude'), absent)
  check('snapshot missing ⇒ no identity, signed out (the top-level file is never consulted)', !fell.authed && fell.uuid === undefined && fell.email === undefined, JSON.stringify(fell))
  const loginOnly = probeScopeAuth(join(home, '.claude'), stored)
  check('a stored login with no snapshot ⇒ signed in, identity unknown (never the top-level file)', loginOnly.authed && loginOnly.uuid === undefined && loginOnly.email === undefined, JSON.stringify(loginOnly))
  writeFileSync(join(home, '.claude', '.claude.json'), '{not json')
  const malformed = probeScopeAuth(join(home, '.claude'), absent)
  check('malformed snapshot ⇒ no identity (a state, not a crash; never the top-level file)', !malformed.authed && malformed.uuid === undefined)
  writeFileSync(join(home, '.claude', '.claude.json'), id('uuid-user-a', 'user-a@example.com'))

  console.log("\n── the default store read: the scope's OWN credential store, in isolation")
  mkdirSync(join(home, '.claude-account-c'), { recursive: true })
  writeFileSync(join(home, '.claude-account-c', '.credentials.json'), '{}')
  const emptyStore = probeScopeAuth(join(home, '.claude-account-c'))
  check('a credential file holding no claude.ai login is NOT a sign-in (the file-presence heuristic is dead)', !emptyStore.authed && emptyStore.uuid === undefined, JSON.stringify(emptyStore))
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
  check('a stored claude.ai login reads signed in through the audited scoped reader (no uuid without a snapshot)', storedOnly.authed && storedOnly.uuid === undefined, JSON.stringify(storedOnly))

  // (There is no dedupeScopes roster-collapse law — with the
  // single-scope universe, one resolved-home scope has nothing to
  // collapse.)
  check('readScopeIdentity: absent file ⇒ {}', readScopeIdentity(join(home, 'nope.json')).uuid === undefined)

  console.log('\n── structural: the single-scope universe + board wiring')
  const src = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/parity/AccountView.tsx'), 'utf8')
  const scanSrc = readFileSync(join(import.meta.dir, '../../src/utils/accounts/scopeScan.ts'), 'utf8')
  // ACCOUNT-SLOT SIMPLIFICATION: the anthropic
  // slot universe is exactly the RESOLVED CONFIG HOME. No enumeration of
  // sibling homes or rosters survives anywhere in the scan.
  check('the scan universe is the resolved home only (no enumeration)',
    scanSrc.includes('const dir = resolve(getMercuryHome())') && !scanSrc.includes('readdirSync'))
  // CLASS ISOLATION: a Claude-family resolved home renders marked, never billable.
  check('a Claude-family resolved home is marked, never billable',
    scanSrc.includes('claudeFamily: isClaudeFamilyDir(dir)') && src.includes("another tool's credential scope"))
  check('the board consumes the ONE scan owner (no second copy)',
    src.includes('deriveFamilySlotGroups()') && !src.includes('readdirSync(home'))
  // NO SWITCH ARMS: the board's ↵ signs in / re-logins
  // in place; nothing re-points a credential.
  check('no credential re-pointing arm survives on the board',
    !src.includes('slotScopeCredential') && !src.includes('writeSelectedAccount'))
  // Removal routes
  // through the accountSlots executor; the anthropic slot's backspace is a
  // plain SIGN-OUT — the home dir itself is never deleted or offered for rm.
  const slotsSrc = readFileSync(join(import.meta.dir, '../../src/services/providers/accountSlots.ts'), 'utf8')
  check('backspace signs out — the home dir is never deleted',
    slotsSrc.includes('The home dir itself is') && !slotsSrc.includes('rm -rf') && src.includes('executeSlotRemoval('))
  check('identity is live-verified (credential-derived, not snapshot-only); the board paints the seam\'s ONE row composer',
    src.includes('resolveLiveScopeIdentity') && src.includes('scopeSlotTail(state, id, slot)') && slotsSrc.includes('verified live'))
  // ONE ROW GRAMMAR: the sign-in row carries no scope facts — the session's
  // scope is the This-session grid's own row; the absent row paints the
  // seam's template like every other family.
  check('the scope row carries no scope facts; the This-session grid does',
    !src.includes("'this session'") && src.includes("{ k: 'scope'") && src.includes('tail = scopeSlotTail(state, id, slot)'))
  check('the absent row paints the one template (no per-family prose survives on the board)',
    src.includes('tail = familyAbsentWords(row.family.id)') && !src.includes('FAMILY_CONNECT_ROUTES') && !src.includes('not connected · ↵ opens Logins'))
  // PRE-FOCUS PARITY: every family the /logins menu carries is reachable by
  // name — huggingface included (the row existed; the vocabulary lagged).
  const loginSrc = readFileSync(join(import.meta.dir, '../../src/commands/login/login.tsx'), 'utf8')
  const flowSrc = readFileSync(join(import.meta.dir, '../../src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  check('/logins huggingface (and hf) pre-focus the Hugging Face row',
    loginSrc.includes("case 'huggingface':") && loginSrc.includes("case 'hf':"))
  // The family union lives at THE row owner (loginFamilyRows.ts); the flow's
  // focus type aliases it, so the vocabulary can never lag the rows.
  const rowOwnerSrc = readFileSync(join(import.meta.dir, '../../src/components/loginFamilyRows.ts'), 'utf8')
  check('the flow accepts every family focus through ONE union (huggingface · moonshot · zai · deepseek), no silent drop',
    flowSrc.includes('initialFocus?: LoginFamilyFocus') &&
      flowSrc.includes('LoginFamilyFocus = LoginFamilyValue') &&
      ["| 'huggingface'", "| 'moonshot'", "| 'zai'", "| 'deepseek'"].every(member => rowOwnerSrc.includes(member)))
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(fail === 0 ? '\n✅ prove-accounts-display: ALL PASS' : `\n❌ prove-accounts-display: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
