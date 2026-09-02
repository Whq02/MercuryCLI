// ============================================================================
//  utils/accounts/accountIdentity — CREDENTIAL-DERIVED account identity
//
//
//  The class this closes: /accounts displayed identity from `.claude.json`
//  oauthAccount SNAPSHOTS — files that are only written at login time, into
//  a home resolved by the memoized primary-bound getGlobalMercuryFile(). A
//  scope whose credential was later re-logged elsewhere kept the OLD email
//  forever: the board showed one account while the keychain billed another
//  (the operator's "couldn't figure out what account it is" — the pin said
//  one identity, the scan said a second, and the CREDENTIAL belonged to a
//  third).
//
//  The fix: identity comes from the scope's OWN credential, verified
//  against the OAuth profile endpoint (the same endpoint the auth stack
//  already uses), with a bounded in-memory cache. The snapshot is only the
//  OFFLINE fallback and is always LABELED unverified. On successful
//  verification the scope's own dir-scoped snapshot is HEALED in place so
//  even offline fallbacks converge on truth.
//
//  Secrets never leave this module: tokens are read through the audited
//  scoped reader (scopedCredentialRead) and used solely as a Bearer header;
//  nothing token-shaped is returned, logged, or shown.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getOauthConfig } from '../../constants/oauth.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../debug.js'
import { readAccountOAuthCreds } from './scopedCredentialRead.js'
import { readScopeIdentity } from './scopeScan.js'
import { signInLedgerEpoch } from './signInLedger.js'

export type ScopeIdentityState =
  | { state: 'verified'; email: string; uuid?: string }
  | { state: 'expired'; snapshotEmail?: string }
  | { state: 'signed-out' }
  | { state: 'unverified'; email?: string; note: string }

const CACHE_TTL_MS = 5 * 60_000
/** Keyed on the scope dir; an entry is served only inside its TTL AND at
 *  the sign-in epoch it was resolved under — a credential that landed or
 *  left in this process (a board sign-out, a re-login under another
 *  account) moves the epoch, so a verified identity can never outlive its
 *  credential here. */
const cache = new Map<string, { at: number; epoch: number; value: ScopeIdentityState }>()

/** Forget a scope's resolved identity (every scope's when no dir is given):
 *  the removal owners call it when a credential leaves, the reauth when one
 *  lands, the board's rescan when the operator asks — the next read
 *  re-derives from the scope's own store. */
export function forgetScopeIdentity(dir?: string): void {
  if (dir === undefined) cache.clear()
  else cache.delete(dir)
}

/** TEST-ONLY alias: reset the identity cache. */
export function _resetIdentityCacheForTesting(): void {
  forgetScopeIdentity()
}

export interface ResolveIdentityDeps {
  readCreds?: typeof readAccountOAuthCreds
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Resolve a scope's LIVE identity from its own credential. Never throws;
 * network failure degrades to the labeled-unverified snapshot.
 */
export async function resolveLiveScopeIdentity(
  dir: string,
  deps: ResolveIdentityDeps = {},
): Promise<ScopeIdentityState> {
  const cached = cache.get(dir)
  const epoch = signInLedgerEpoch()
  if (cached && cached.epoch === epoch && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const value = await resolveUncached(dir, deps)
  // Never cache transient network failures — the next open retries. The
  // entry remembers the epoch the probe STARTED under: a credential that
  // moved while the profile call was out invalidates it at once.
  if (value.state !== 'unverified') cache.set(dir, { at: Date.now(), epoch, value })
  return value
}

function snapshotEmail(dir: string): string | undefined {
  return readScopeIdentity(join(dir, '.claude.json')).email
}

async function resolveUncached(
  dir: string,
  deps: ResolveIdentityDeps,
): Promise<ScopeIdentityState> {
  const readCreds = deps.readCreds ?? readAccountOAuthCreds
  let creds: ReturnType<typeof readAccountOAuthCreds>
  try {
    creds = readCreds(dir)
  } catch {
    creds = undefined
  }
  if (!creds?.accessToken) return { state: 'signed-out' }

  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 4_000
  try {
    const response = await fetchImpl(`${getOauthConfig().BASE_API_URL}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401 || response.status === 403) {
      const snap = snapshotEmail(dir)
      return { state: 'expired', ...(snap !== undefined && { snapshotEmail: snap }) }
    }
    if (!response.ok) {
      const snap = snapshotEmail(dir)
      return {
        state: 'unverified',
        ...(snap !== undefined && { email: snap }),
        note: `profile endpoint answered ${response.status}`,
      }
    }
    const profile = (await response.json()) as {
      account?: { email_address?: string; email?: string; uuid?: string }
    }
    const email = profile.account?.email_address ?? profile.account?.email
    if (!email) {
      const snap = snapshotEmail(dir)
      return {
        state: 'unverified',
        ...(snap !== undefined && { email: snap }),
        note: 'profile carried no email',
      }
    }
    const uuid = profile.account?.uuid
    const verified: ScopeIdentityState = {
      state: 'verified',
      email,
      ...(uuid !== undefined && { uuid }),
    }
    healScopeIdentitySnapshot(dir, { email, ...(uuid !== undefined && { uuid }) })
    return verified
  } catch (err) {
    const snap = snapshotEmail(dir)
    return {
      state: 'unverified',
      ...(snap !== undefined && { email: snap }),
      note: `offline (${(err as Error).name ?? 'fetch failed'})`,
    }
  }
}

/**
 * Write-through heal: converge the scope's OWN dir-scoped snapshot on the
 * verified identity (merge — other fields survive). Never throws; a
 * read-only scope simply keeps its stale file (still labeled by the live
 * path next time).
 */
export function healScopeIdentitySnapshot(
  dir: string,
  identity: { email: string; uuid?: string },
): void {
  try {
    const file = join(dir, '.claude.json')
    let parsed: Record<string, unknown> = {}
    if (existsSync(file)) {
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch (readErr) {
        // A snapshot this reader cannot parse is never republished from an
        // empty object: that write would replace every other key the file
        // holds with the identity alone. The damaged bytes stay as they are
        // and the heal waits for a readable file.
        logForDebugging(`[accounts] snapshot heal skipped for ${dir}: the file is not readable JSON (${String(readErr)})`)
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        logForDebugging(`[accounts] snapshot heal skipped for ${dir}: the file is not a JSON object`)
        return
      }
    }
    const prior = (parsed.oauthAccount ?? {}) as Record<string, unknown>
    if (prior.emailAddress === identity.email && (!identity.uuid || prior.accountUuid === identity.uuid)) {
      return // already true — no write
    }
    parsed.oauthAccount = {
      ...prior,
      emailAddress: identity.email,
      ...(identity.uuid !== undefined && { accountUuid: identity.uuid }),
    }
    durableAtomicPublishSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
    logForDebugging(`[accounts] healed identity snapshot for ${dir} → ${identity.email}`)
  } catch (err) {
    logForDebugging(`[accounts] snapshot heal failed for ${dir}: ${String(err)}`)
  }
}

/**
 * The heal's inverse: drop the scope's OWN dir-scoped identity snapshot —
 * the oauthAccount member of `<dir>/.claude.json`; every other key survives
 * and the file is never deleted. The removal owners call it when the login
 * leaves: a snapshot that outlived its credential was the stale row on the
 * board (signed in by the snapshot, unremovable because the removal found
 * no tokens). Never throws; an unreadable file is left as it is (nothing
 * true is lost — the readers label what they find).
 */
export function clearScopeIdentitySnapshot(dir: string): void {
  try {
    const file = join(dir, '.claude.json')
    if (!existsSync(file)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (readErr) {
      logForDebugging(`[accounts] snapshot clear skipped for ${dir}: the file is not readable JSON (${String(readErr)})`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const record = parsed as Record<string, unknown>
    if (!('oauthAccount' in record)) return
    delete record.oauthAccount
    durableAtomicPublishSync(file, `${JSON.stringify(record, null, 2)}\n`)
    logForDebugging(`[accounts] cleared the identity snapshot for ${dir}`)
  } catch (err) {
    logForDebugging(`[accounts] snapshot clear failed for ${dir}: ${String(err)}`)
  }
}
