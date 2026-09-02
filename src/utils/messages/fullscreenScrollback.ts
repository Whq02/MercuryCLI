// Fullscreen scrollback retention across a compaction boundary. In
// fullscreen, a compaction must not erase the visible history the operator
// scrolled through — it keeps EVERY prior interval, not just the latest one
// (the earlier `slice(lastBoundary)` capped scrollback at a single interval,
// so the second compaction dropped everything before the first). The only
// thing removed is the verbatim tail the new boundary re-yields, so it never
// renders twice. Pure so the prover drives it without a rendered capture.

/**
 * The scrollback to keep BEFORE the incoming compact-boundary message.
 * `preservedHeadUuid` is the boundary's re-yielded preserved-segment head;
 * everything from it onward is dropped (the boundary re-adds it). All prior
 * history — including earlier boundary messages and their scrollback — is
 * retained.
 */
export function retainFullscreenScrollback<M extends { uuid: string }>(
  previous: readonly M[],
  preservedHeadUuid: string | undefined,
): M[] {
  if (preservedHeadUuid !== undefined) {
    const headIndex = previous.findIndex(message => message.uuid === preservedHeadUuid)
    if (headIndex !== -1) return previous.slice(0, headIndex)
  }
  return [...previous]
}
