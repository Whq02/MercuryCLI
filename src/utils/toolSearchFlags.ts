// =============================================================================
// utils / toolSearchFlags.ts
// -----------------------------------------------------------------------------
// Leaf module for the ToolSearch deferral gates — the predicates that both
// tools/ToolSearchTool/prompt.ts and utils/toolSearch.ts need but could not
// share before: toolSearch.ts imports from prompt.ts, so a predicate living in
// either of those files cannot be imported by the other without a cycle. This
// file imports ONLY featureGates (which never imports back), so both consumers
// can import the single source of truth here instead of inlining a copy
// guarded by a "keep these in sync" comment.
// =============================================================================

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'

/**
 * True → announce deferred tools via persisted delta attachments (tool names
 * appear in <system-reminder> messages). False → claude.ts keeps its per-call
 * <available-deferred-tools> header prepend (the attachment does not fire).
 *
 * Gated on the `mercury_glacier_2xr` feature gate — PINNED ON in
 * FORK_GATE_TABLE (services/analytics/featureGates.ts, FN-020 row 1); the
 * inline default stays false, so an unpinned table restores the header
 * prepend byte-for-byte.
 * Consumed by isDeferredToolsDeltaEnabled (re-exported from utils/toolSearch.ts
 * for attachments.ts / claude.ts) and by getToolLocationHint in
 * tools/ToolSearchTool/prompt.ts.
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('mercury_glacier_2xr', false)
  )
}
