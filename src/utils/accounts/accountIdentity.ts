
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getOauthConfig } from '../../constants/oauth.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../debug.js'
import { readAccountOAuthCreds } from './scopedCredentialRead.js'
import { readScopeIdentity } from './scopeScan.js'

export type ScopeIdentityState =
  | { state: 'verified'; email: string; uuid?: string }
  | { state: 'expired'; snapshotEmail?: string }
  | { state: 'signed-out' }
  | { state: 'unverified'; email?: string; note: string }

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; value: ScopeIdentityState }>()

export function _resetIdentityCacheForTesting(): void {
  cache.clear()
}

export interface ResolveIdentityDeps {
  readCreds?: typeof readAccountOAuthCreds
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function resolveLiveScopeIdentity(
  dir: string,
  deps: ResolveIdentityDeps = {},
): Promise<ScopeIdentityState> {
  const cached = cache.get(dir)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const value = await resolveUncached(dir, deps)
  if (value.state !== 'unverified') cache.set(dir, { at: Date.now(), value })
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
      return
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
