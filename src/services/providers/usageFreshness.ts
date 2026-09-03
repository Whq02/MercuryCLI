// ============================================================================
//  providers/usageFreshness — the ONE vocabulary for where a usage figure
//  came from and how old it is.
//
//  Every usage meter is a perishable provider fact: a polled endpoint's
//  answer, a response header's statement, or a render seed. A figure painted
//  without its source and age reads as live truth forever — the lie this
//  owner retires. Two facts, one composer:
//    · the FEED    — 'endpoint' (a polled read), 'headers' (observed on a
//                    response), 'seed' (a render fixture);
//    · the FRESHNESS — live while the read is younger than the horizon its
//                    reader would refresh it at; STALE beyond it ("stale ·
//                    last read N min ago"), never painted as live; unstamped
//                    when the record carries no observation time.
//  The horizons are the readers' own cadences: a polled reader's TTL (one
//  number, imported by every polling reader from here so the words and the
//  refresh can never disagree), and the per-response horizon for a feed
//  that has no timer (a fresh reply refreshes it; an idle session ages it).
//  This module imports nothing, so every reader may import it.
// ============================================================================

/** Where a usage figure came from. */
export type UsageFeed = 'endpoint' | 'headers' | 'seed'

/** The polled readers' one refresh cadence (the key-truth, balance and
 *  managed-usage probes): a read younger than this is what the reader would
 *  serve again unasked; older, the reader would re-poll — so the figure is
 *  stale until a surface asks. */
export const USAGE_POLL_TTL_MS = 60_000

/** The per-response feeds (subscription rate-limit headers, the usage
 *  endpoint a tab samples on mount) have no timer: five minutes — one part
 *  in sixty of the shortest rolling window — is the horizon past which the
 *  figure reads as stale. */
export const USAGE_RESPONSE_FRESH_MS = 5 * 60_000

export interface UsageFreshnessFacts {
  source?: UsageFeed
  observedAtMs?: number
  /** The reader's horizon for this figure; absent ⇒ the feed's default. */
  freshForMs?: number
}

export type UsageFreshness =
  | { state: 'live'; ageMs: number }
  | { state: 'stale'; ageMs: number }
  | { state: 'unstamped' }

/** The default horizon per feed (a polled read: the poll TTL; a response
 *  feed: the response horizon; a seed never ages — it is a fixture). */
export function usageFreshHorizonMs(source: UsageFeed | undefined): number {
  if (source === 'seed') return Number.POSITIVE_INFINITY
  if (source === 'endpoint') return USAGE_POLL_TTL_MS
  return USAGE_RESPONSE_FRESH_MS
}

/** Live / stale / unstamped for one figure at `now`. A clock that runs
 *  behind the stamp reads as age zero, never negative. */
export function usageFreshness(facts: UsageFreshnessFacts, now: number = Date.now()): UsageFreshness {
  if (facts.observedAtMs === undefined || !Number.isFinite(facts.observedAtMs)) return { state: 'unstamped' }
  const ageMs = Math.max(0, now - facts.observedAtMs)
  const horizon = facts.freshForMs ?? usageFreshHorizonMs(facts.source)
  return ageMs > horizon ? { state: 'stale', ageMs } : { state: 'live', ageMs }
}

/** The feed word: 'endpoint-fed' · 'header-fed' · 'seeded'. */
export function usageFeedWord(source: UsageFeed | undefined): string | undefined {
  if (source === 'endpoint') return 'endpoint-fed'
  if (source === 'headers') return 'header-fed'
  if (source === 'seed') return 'seeded'
  return undefined
}

/** An age in words: '12 s' · '3 min' · '2 h 5 min' · '3 d'. */
export function formatUsageAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 > 0 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

/** The same age for a narrow column: '12s' · '3m' · '2h' · '3d'. */
export function formatUsageAgeShort(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * THE source + freshness words, one spelling for every family:
 *   'endpoint-fed · read 12 s ago'
 *   'header-fed · read 3 min ago'
 *   'endpoint-fed · stale · last read 12 min ago'
 *   'seeded'
 *   'endpoint-fed'            (a record with no observation stamp)
 * Undefined when the figure names no feed and no stamp (nothing to say).
 */
export function usageSourceWords(facts: UsageFreshnessFacts, now: number = Date.now()): string | undefined {
  const feed = usageFeedWord(facts.source)
  const fresh = usageFreshness(facts, now)
  const parts: string[] = []
  if (feed !== undefined) parts.push(feed)
  if (facts.source !== 'seed') {
    if (fresh.state === 'live') parts.push(`read ${formatUsageAge(fresh.ageMs)} ago`)
    else if (fresh.state === 'stale') parts.push(`stale · last read ${formatUsageAge(fresh.ageMs)} ago`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** The narrow-column tail for a STALE figure ('↻12m'); undefined while the
 *  figure is live or unstamped — a live meter keeps its reset countdown. */
export function usageStaleTail(facts: UsageFreshnessFacts, now: number = Date.now()): string | undefined {
  const fresh = usageFreshness(facts, now)
  return fresh.state === 'stale' ? `↻${formatUsageAgeShort(fresh.ageMs)}` : undefined
}

/** The connected-but-unread state, one spelling: nothing has been observed
 *  yet on a lane whose reader CAN answer (the meters fill on the first
 *  reply, or when a surface samples the reader). */
export const NO_USAGE_READ_WORDS = 'no usage read'
