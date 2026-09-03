// ============================================================================
//  src/constants/systemPromptSections.ts — section memoization primitives
//  over the cache the bootstrap state module owns.
//
//  Three constructors, one resolver: plain memoized sections compute once
//  per conversation; dependency-keyed sections additionally carry a cheap
//  synchronous key and recompute exactly once when it moves (a name-only
//  cache served a stale value after a live model switch); cache-breaking
//  sections recompute every turn.
// ============================================================================
import {
  clearBetaHeaderLatches,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
  clearSystemPromptSectionState,
} from '../bootstrap/state.js'
import { clearToolRosterLatches } from '../services/providers/toolEconomy.js'

type SectionValue = string | null

export type SystemPromptSection = {
  name: string
  compute: () => SectionValue | Promise<SectionValue>
  /** Cheap and synchronous; null when the section has no key. */
  computeKey: (() => string) | null
  /** Cache-breaking sections always compute and always write back. */
  cacheBreaking: boolean
}

/** A plain memoized section: computed once, cached until /clear or /compact. */
export function systemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return { name, compute, computeKey: null, cacheBreaking: false }
}

/**
 * A dependency-keyed section: the cached value is valid only while the key
 * is unchanged; when the key moves the section recomputes exactly once.
 */
export function keyedSystemPromptSection(
  name: string,
  computeKey: () => string,
  compute: () => SectionValue | Promise<SectionValue>,
): SystemPromptSection {
  return { name, compute, computeKey, cacheBreaking: false }
}

/**
 * Recomputes every turn — and by construction breaks the prompt cache when
 * its value changes. The mandatory reason is not used at runtime; it exists
 * to force the author to justify the cache break.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => SectionValue | Promise<SectionValue>,
  reason: string,
): SystemPromptSection {
  void reason
  return { name, compute, computeKey: null, cacheBreaking: true }
}

/**
 * Resolve all sections concurrently. A non-cache-breaking cache hit whose
 * stored key equals the computed key short-circuits WITHOUT rewriting the
 * entry (entry object identity is the zero-recompute observable a prover
 * pins). Invariant: the cache is per-name — two sections must not share one.
 */
export function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<SectionValue[]> {
  const cache = getSystemPromptSectionCache()
  return Promise.all(
    sections.map(async section => {
      const key = section.computeKey ? section.computeKey() : null
      if (!section.cacheBreaking) {
        const cached = cache.get(section.name)
        if (cached !== undefined && cached.key === key) return cached.value
      }
      const value = await section.compute()
      setSystemPromptSectionCacheEntry(section.name, value, key)
      return value
    }),
  )
}

/**
 * Clears the section cache, the beta-header latches AND the tool-roster
 * latches, so a fresh conversation re-evaluates conditional beta headers
 * and re-decides its roster. Called on /clear and /compact — the lawful
 * prefix boundaries.
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
  clearToolRosterLatches()
}
