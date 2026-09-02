// ============================================================================
//  ink/root/flush-registry.ts — the nonessential-
//  flush registry.
//
//  OBSERVABILITY ONLY, by design: every client that arms deferred
//  nonessential flushes (StreamBatcher instances, the streaming tail
//  store) registers a {name, pending()} probe, so ONE place can enumerate
//  every pending nonessential flush in the estate. The RenderScheduler
//  does NOT consult it — T6's scheduler stays the sole paint owner; this
//  exists so the bounded-queue law (≤1 pending flush per client) is
//  assertable ESTATE-WIDE instead of per-instance, and so a wedged flush
//  has a name when someone goes looking.
//
//  The echo-policy decision is KEEP (a recorded
//  decision): a keystroke inside an open 16ms throttle window waits for the
//  boundary and coalesces — the floors are already met (idle p95 16.9ms ≤
//  20 · stream+tool ≤ 30), the coalesced wait is mechanically bounded by
//  FRAME_INTERVAL_MS, and a mid-window input bypass is an urgent-class
//  flush by another name. The two OPEN-WINDOW
//  contract checks stay green untouched — the conscious keep.
// ============================================================================

export type FlushProbe = {
  name: string
  /** How many deferred flushes this client currently has armed (the
   *  bounded-queue law says ≤1, always). */
  pending(): number
}

const probes = new Set<FlushProbe>()

/** Register at construction; the disposer unregisters (unmount safety). */
export function registerFlushProbe(probe: FlushProbe): () => void {
  probes.add(probe)
  return () => {
    probes.delete(probe)
  }
}

/** Every armed nonessential flush in the estate, by name. */
export function pendingFlushes(): Array<{ name: string; pending: number }> {
  const out: Array<{ name: string; pending: number }> = []
  for (const probe of probes) {
    const pending = probe.pending()
    if (pending > 0) out.push({ name: probe.name, pending })
  }
  return out
}

/** The registered probe census (for the estate-wide law + diagnostics). */
export function flushProbeCount(): number {
  return probes.size
}
