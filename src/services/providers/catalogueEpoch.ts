// ============================================================================
//  providers/catalogueEpoch — the ONE change signal for every live model
//  catalogue (OpenAI · OpenRouter · Gemini · Hugging Face) and for local
//  server discovery — every source a persisted id's context window derives from.
//
//  The catalogues are sync-over-cache: a picker reads getCachedXCatalogue()
//  while it renders, and an unfetched lane kicks a background refresh. The
//  refresh settling — rows landed, a labelled failure, an unavailable
//  account — used to change nothing on screen: the picker had no way to
//  know, so the operator saw "connecting…" until a SECOND open re-read the
//  cache. Every settle now bumps this epoch; a surface that paints
//  catalogue-derived rows subscribes (useCatalogueEpoch) and re-reads its
//  options in place. One owner, one signal, no per-family plumbing.
// ============================================================================

let epoch = 0
const listeners = new Set<() => void>()

/** The current epoch — a monotonically increasing settle count. */
export function catalogueEpoch(): number {
  return epoch
}

/** Called by every catalogue refresh when its snapshot settles (success,
 *  labelled failure, or account-unavailable alike — each is a fact the
 *  screen must reflect). */
export function bumpCatalogueEpoch(): void {
  epoch += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // a subscriber's failure never stalls the other subscribers
    }
  }
}

export function subscribeCatalogueEpoch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
