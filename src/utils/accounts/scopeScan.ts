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
// Pure node:fs + path — deliberately bun-loadable so the proof
// (scripts/accounts/prove-accounts-display.ts) exercises the real functions.
// Never reads a token: identity comes from the non-secret oauthAccount
// fields; credential-FILE presence is the non-keychain auth fallback.

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

/** Sign-in probe for a scope dir: the dir-scoped identity snapshot
 *  (`<dir>/.claude.json` — the snapshot basename the scope stores use),
 *  with credential-file presence keeping non-keychain platforms honest. */
export function probeScopeAuth(
  dir: string,
): { authed: boolean; email?: string; uuid?: string } {
  const id = readScopeIdentity(join(dir, '.claude.json'))
  if (id.uuid) {
    return { authed: true, uuid: id.uuid, ...(id.email ? { email: id.email } : {}) }
  }
  const credFile = existsSync(join(dir, '.credentials.json'))
  return { authed: credFile }
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
export function scanAccountScopes(): AccountScope[] {
  const dir = resolve(getMercuryHome())
  return [
    {
      name: 'primary',
      dir,
      isCurrent: true,
      hasConfig: existsSync(join(dir, '.claude.json')),
      claudeFamily: isClaudeFamilyDir(dir),
      ...probeScopeAuth(dir),
    },
  ]
}
