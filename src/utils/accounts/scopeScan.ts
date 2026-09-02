// utils/accounts/scopeScan — the anthropic login-scope read for the
// /accounts board and the wallet.
//
// THE SLOT UNIVERSE IS THE RESOLVED CONFIG HOME (account-slot simplification,
// operator ruling): one anthropic OAuth login per session home.
// The former sibling-home enumeration (per-account sibling homes, both
// sovereign families' rosters) was the account-ring switching machinery and
// is retired with it — a sibling home is a separate estate an operator boots
// with an explicit MERCURY_CONFIG_DIR pin, never a slot of this session.
//
// Pure node:fs + path for the identity half — deliberately bun-loadable so
// the proof (scripts/accounts/prove-accounts-display.ts) exercises the real
// functions. Identity comes from the non-secret oauthAccount snapshot;
// SIGN-IN comes from the scope's credential store (existence only — no
// token value ever leaves the read; the store read is injectable).

import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { getMercuryHome } from '../envUtils.js'

export type ScopeIdentity = { uuid?: string; email?: string }

/** One enumerated Anthropic account scope (the /accounts slot universe row
 *  and the wallet's anthropic-oauth custodian answer). */
export type AccountScope = {
  name: string
  dir: string
  isCurrent: boolean
  hasConfig: boolean
  authed: boolean
  email?: string
  uuid?: string
  /** A foreign Claude-family home that happens to be this session's resolved
   *  home (env-pinned run) — shown for honesty, never selectable. */
  claudeFamily: boolean
}

/**
 * CLASS ISOLATION: the CLAUDE-family homes (~/.claude, ~/.claude-*) belong to
 * another tool — Mercury must NEVER bill through them. A CLAUDE-family
 * resolved home renders on /accounts for honesty and is never billable;
 * Mercury's own login home is a sovereign home exclusively (~/.mercury).
 */
export function isClaudeFamilyDir(dir: string): boolean {
  const base = basename(dir.replace(/[\\/]+$/, ''))
  return base === '.claude' || base.startsWith('.claude-')
}

/** Non-secret oauthAccount identity from ONE config file. Missing/unparseable
 *  file ⇒ {} (a state, not an error). */
export function readScopeIdentity(configFile: string): ScopeIdentity {
  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as {
      oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown }
    }
    const oa = parsed.oauthAccount
    if (oa && typeof oa.accountUuid === 'string' && oa.accountUuid.trim()) {
      return {
        uuid: oa.accountUuid.trim(),
        ...(typeof oa.emailAddress === 'string' && oa.emailAddress.trim()
          ? { email: oa.emailAddress.trim() }
          : {}),
      }
    }
  } catch {
    // fall through — absent/unreadable config is a legitimate scope state
  }
  return {}
}

/** Injectable store read for provers; production reads the scope's own
 *  credential store. */
export interface ScopeAuthReads {
  /** A claude.ai login is STORED for the scope dir (existence — never
   *  validity). */
  storedLogin?: (dir: string) => boolean
}

/**
 * Sign-in probe for a scope dir. SIGNED IN means the scope's credential
 * store holds a claude.ai login — the same store the wire reads — never the
 * identity snapshot: `<dir>/.claude.json` (the snapshot basename the scope
 * stores use) is written by the board's verification heal and cleared by
 * the removal owners, and a snapshot that outlives its credential (a
 * removal by another tool, an interrupted sign-out) reads as SIGNED OUT
 * with its identity labelled, never as a login. The stale-row class this
 * closes: a row that said "signed in" for a credential that had left, and
 * could not be removed because the removal found no tokens. The snapshot
 * supplies identity only.
 */
export function probeScopeAuth(
  dir: string,
  reads: ScopeAuthReads = {},
): { authed: boolean; email?: string; uuid?: string } {
  const id = readScopeIdentity(join(dir, '.claude.json'))
  const authed = (reads.storedLogin ?? storedLoginLive)(dir)
  return {
    authed,
    ...(id.uuid ? { uuid: id.uuid } : {}),
    ...(id.email ? { email: id.email } : {}),
  }
}

/** The stored-login read: the resolved home (the one scope this session
 *  bills) asks the credential owner's own presence predicate — the store the
 *  wire reads, through its door (its keychain cache keeps a render-path read
 *  cheap; the auth-scope seam stays the stores' own, never read here); any
 *  other dir reads in isolation through the audited scoped reader. A
 *  refusing store (a locked keychain, an unreadable file) reads as signed
 *  out — a state, never a throw. Call-time requires keep the module's
 *  import graph the pure one the proof loads. */
function storedLoginLive(dir: string): boolean {
  try {
    if (resolve(dir) === resolve(getMercuryHome())) {
      const { hasStoredOAuthToken } = require('../auth.js') as typeof import('../auth.js')
      return hasStoredOAuthToken()
    }
    const { readAccountOAuthCreds } =
      require('./scopedCredentialRead.js') as typeof import('./scopedCredentialRead.js')
    return readAccountOAuthCreds(dir) !== undefined
  } catch {
    return false
  }
}

/**
 * The anthropic scope universe: exactly the RESOLVED config home — the one
 * login the session bills (ideology law 1). Shared by the /accounts board
 * and the wallet so the two surfaces can never diverge. A CLAUDE-family
 * resolved home (an env-pinned run on another tool's home) renders for
 * honesty but is never billable from Mercury (the class-isolation
 * ruling); the name speaks the ROLE (the UX label law) — the session's own
 * home is 'primary', whatever its basename.
 */
export function scanAccountScopes(reads: ScopeAuthReads = {}): AccountScope[] {
  const dir = resolve(getMercuryHome())
  return [
    {
      name: 'primary',
      dir,
      isCurrent: true,
      hasConfig: existsSync(join(dir, '.claude.json')),
      claudeFamily: isClaudeFamilyDir(dir),
      ...probeScopeAuth(dir, reads),
    },
  ]
}
