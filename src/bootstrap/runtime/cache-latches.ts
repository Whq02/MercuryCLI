// ============================================================================
//  src/bootstrap/runtime/cache-latches.ts — the cache-latch family owner
//
//
//  Scope: MIXED, deliberately co-owned (prompt-cache correctness is ONE
//  concern):
//   - the four beta-header latches are CONVERSATION-scoped — cleared ONLY by
//     clearBetaHeaderLatches (/clear + /compact). A latch silently dropped
//     or wrongly cleared is a prompt-cache-bust cost bug invisible to every
//     other suite (prove-state-contract LAW 5 + SCOPE-DELTA are the net).
//   - the prompt-cache-1h allowlist/eligibility pair is SESSION-latched
//     (mid-session overage flips must NOT change cache_control TTL) — it is
//     NOT in the clear set.
//   - systemPromptSectionCache + lastEmittedDate are session caches with
//     their own clear (clearSystemPromptSectionState / setter).
//
//  A NEW `*Latched` cell added here MUST join clearBetaHeaderLatches — the
//  prover's fifth-latch tripwire sweeps this file's source and fails the
//  gate otherwise.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports nothing. src/bootstrap/
//  state.ts is the ONLY sanctioned importer; every consumer goes through the
//  frozen facade.
// ============================================================================

export class CacheLatchOwner {
  // The feature-gate 1h-TTL allowlist, captured once per session — the TTL
  // decision must not follow a mid-session gate refresh.
  promptCache1hAllowlist: string[] | null = null
  // The 1h-TTL eligibility verdict, latched at first evaluation. An overage
  // state flip mid-session would otherwise flip cache_control's TTL — and a
  // TTL change is a full server-side prompt-cache bust.
  promptCache1hEligible: boolean | null = null
  // AFK_MODE_BETA_HEADER latch: once flow activates, the header keeps
  // going out for the rest of the conversation — Shift+Tab mode toggles
  // must not cycle the header set (each cycle busts a ~50-70K-token cache).
  afkModeHeaderLatched: boolean | null = null
  // Cache-editing beta-header latch: first enable of cached microcompact
  // pins the header against mid-session gate/settings toggles.
  cacheEditingHeaderLatched: boolean | null = null
  // Thinking-clear latch. Armed when >1h passed since the last API call —
  // the cache is already cold, so dropping prior-loop thinking costs no
  // hit. Once armed it stays on: flipping back to keep:'all' would bust the
  // freshly warmed thinking-cleared cache.
  thinkingClearLatched: boolean | null = null
  // System prompt section cache state. Entries carry the section's
  // dependency key: `key` is null for plain name-cached
  // sections; a keyed section recomputes iff its computeKey() no longer
  // matches — the seam that lets mutable runtime identity (the applied
  // model) live inside a cached section without going stale at a live
  // switch and without per-turn recompute (prompt-cache discipline, L4).
  systemPromptSectionCache: Map<
    string,
    { key: string | null; value: string | null }
  > = new Map()
  // The date last rendered into the model's context — compared each turn so
  // a session running across midnight announces the change.
  lastEmittedDate: string | null = null

  /**
   * Null every beta-header latch. /clear and /compact call this — a fresh
   * conversation re-evaluates its header set from scratch.
   */
  clearBetaHeaderLatches(): void {
    this.afkModeHeaderLatched = null
    this.cacheEditingHeaderLatched = null
    this.thinkingClearLatched = null
  }
}
