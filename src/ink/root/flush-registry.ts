
export type FlushProbe = {
  name: string
  pending(): number
}

const probes = new Set<FlushProbe>()

export function registerFlushProbe(probe: FlushProbe): () => void {
  probes.add(probe)
  return () => {
    probes.delete(probe)
  }
}

export function pendingFlushes(): Array<{ name: string; pending: number }> {
  const out: Array<{ name: string; pending: number }> = []
  for (const probe of probes) {
    const pending = probe.pending()
    if (pending > 0) out.push({ name: probe.name, pending })
  }
  return out
}

export function flushProbeCount(): number {
  return probes.size
}
