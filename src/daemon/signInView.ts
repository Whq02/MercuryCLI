import { providerFamilyPresences } from '../services/providers/providerUsage.js'
import { dropCredentialMemos } from '../utils/auth.js'
import { getAuthConfigHomeDir } from '../utils/envUtils.js'
import { computedDefault, resetComputedDefaultMemo } from '../utils/model/computedDefault.js'
import { getSecureStorage } from '../utils/secureStorage/index.js'
import type { DaemonSignInViewV1, SignInFamilyViewV1 } from './protocol.js'

const LIVE_READ_TTL_MS = 2_000
let lastLiveReadAt = 0

export function refreshSignInReads(force = false): boolean {
  const now = Date.now()
  if (!force && now - lastLiveReadAt < LIVE_READ_TTL_MS) return false
  lastLiveReadAt = now
  dropCredentialMemos()
  resetComputedDefaultMemo()
  return true
}

export function __resetSignInReadThrottleForTest(): void {
  lastLiveReadAt = 0
}

export function composeSignInView(opts?: { refresh?: boolean }): DaemonSignInViewV1 {
  const refreshed = refreshSignInReads(opts?.refresh === true)
  const decision = computedDefault()
  const considered = new Map(decision.considered.map(c => [c.family, c] as const))
  const families: SignInFamilyViewV1[] = decision.considered.map(c => ({
    family: c.family,
    credentialed: true,
    ...(c.label !== undefined ? { label: c.label } : {}),
    usable: c.verdict.usable,
    ...(c.verdict.usable ? { row: c.verdict.row } : {}),
    why: c.verdict.why,
    signedInAt: c.at,
  }))
  for (const presence of providerFamilyPresences()) {
    if (considered.has(presence.id)) continue
    families.push({
      family: presence.id,
      credentialed: presence.credentialed,
      ...(presence.credentialLabel !== undefined ? { label: presence.credentialLabel } : {}),
      usable: false,
      why: presence.credentialed ? 'a credential is present but the read did not enumerate it' : 'no credential',
    })
  }
  return {
    home: getAuthConfigHomeDir(),
    store: getSecureStorage().name,
    defaultFamily: decision.provider,
    readAt: Date.now(),
    refreshed,
    families,
  }
}

export function describeSignInRead(family: string): string {
  const view = composeSignInView()
  const where = `the daemon read the ${view.store} credential store in ${view.home}`
  const entry = view.families.find(f => f.family === family)
  if (entry !== undefined && entry.credentialed && !entry.usable) {
    return `${where}; a credential is present for ${family} but no usable row (${entry.why ?? 'no row'}) — a catalogue fix, not a sign-in`
  }
  return where
}

export function summarizeSignInView(view: DaemonSignInViewV1): string {
  const signedIn = view.families.filter(f => f.credentialed)
  const none = view.families.filter(f => !f.credentialed).map(f => f.family)
  const words = signedIn.map(f => `${f.family}: ${f.usable ? `usable (${f.row ?? '?'})` : `no usable row (${f.why ?? '?'})`}`)
  return `${words.length > 0 ? words.join(' · ') : 'no family signed in'}${none.length > 0 ? ` · no credential: ${none.join(', ')}` : ''}`
}

export interface SignInViewDifference {
  family: string
  client: string
  daemon: string
}

export function compareSignInViews(client: DaemonSignInViewV1, daemon: DaemonSignInViewV1): SignInViewDifference[] {
  const words = (f: SignInFamilyViewV1 | undefined): string =>
    f === undefined ? 'not listed' : !f.credentialed ? 'no credential' : f.usable ? `signed in, usable (${f.row ?? '?'})` : `signed in, no usable row (${f.why ?? '?'})`
  const same = (a: SignInFamilyViewV1 | undefined, b: SignInFamilyViewV1 | undefined): boolean =>
    (a?.credentialed ?? false) === (b?.credentialed ?? false) && (a?.usable ?? false) === (b?.usable ?? false)
  const out: SignInViewDifference[] = []
  const names = new Set([...client.families.map(f => f.family), ...daemon.families.map(f => f.family)])
  for (const family of names) {
    const mine = client.families.find(f => f.family === family)
    const theirs = daemon.families.find(f => f.family === family)
    if (same(mine, theirs)) continue
    out.push({ family, client: words(mine), daemon: words(theirs) })
  }
  return out
}
