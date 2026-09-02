// ============================================================================
//  src/extensions/blocklist.ts — the blocklist and its owner: the operator.
//
//  `<config home>/settings.json` → `extensions.blocked: [ "<id>" | "<source
//  label>" | "<url or host>" ]`. Policy (managed settings) may carry the
//  same key; those entries read "blocked by policy" and the board cannot
//  unblock them. No remote list ever feeds it. Nothing is blocked by
//  default.
// ============================================================================
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'

export type BlockMatch = { by: 'operator' | 'policy'; entry: string } | null

function entriesFor(source: 'userSettings' | 'policySettings'): string[] {
  const list = getSettingsForSource(source)?.extensions?.blocked
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string' && e.trim() !== '').map(e => e.trim()) : []
}

export function blockedEntries(): { operator: string[]; policy: string[] } {
  return { operator: entriesFor('userSettings'), policy: entriesFor('policySettings') }
}

/** The host of a URL-shaped string, or null. */
export function hostOf(text: string): string | null {
  const scp = /^[^@\s]+@([^:\s]+):/.exec(text)
  if (scp) return scp[1]!.toLowerCase()
  try {
    const url = new URL(text)
    return url.hostname ? url.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * Match a set of candidates (an id, a label, a URL, its host) against the
 * blocklist. Policy wins over the operator so the row says who to ask.
 */
export function matchBlock(candidates: Array<string | null | undefined>): BlockMatch {
  const wanted = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    wanted.add(normalise(candidate))
    const host = hostOf(candidate)
    if (host) wanted.add(host)
  }
  if (wanted.size === 0) return null
  const { operator, policy } = blockedEntries()
  const hit = (entries: string[]): string | null => {
    for (const entry of entries) {
      const n = normalise(entry)
      if (wanted.has(n)) return entry
      const host = hostOf(entry)
      if (host && wanted.has(host)) return entry
    }
    return null
  }
  const byPolicy = hit(policy)
  if (byPolicy) return { by: 'policy', entry: byPolicy }
  const byOperator = hit(operator)
  if (byOperator) return { by: 'operator', entry: byOperator }
  return null
}

/** One line for a refusal: `blocked — b unblocks` / `blocked by policy — ask your administrator`. */
export function blockReason(match: NonNullable<BlockMatch>): string {
  return match.by === 'policy' ? `blocked by policy (${match.entry}) — ask your administrator` : `blocked (${match.entry}) — b unblocks`
}

export function block(entry: string): { ok: true } | { ok: false; error: string } {
  const current = entriesFor('userSettings')
  if (current.includes(entry.trim())) return { ok: true }
  const { error } = updateSettingsForSource('userSettings', { extensions: { blocked: [...current, entry.trim()] } } as never)
  if (error) return { ok: false, error: String(error) }
  return { ok: true }
}

export function unblock(entry: string): { ok: true } | { ok: false; error: string } {
  const policy = entriesFor('policySettings')
  if (policy.includes(entry.trim())) return { ok: false, error: `blocked by policy — ask your administrator` }
  const current = entriesFor('userSettings')
  const next = current.filter(e => e !== entry.trim())
  if (next.length === current.length) return { ok: true }
  const { error } = updateSettingsForSource('userSettings', { extensions: { blocked: next } } as never)
  if (error) return { ok: false, error: String(error) }
  return { ok: true }
}
