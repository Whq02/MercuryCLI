import type { CheckSpec } from '../healthReport.js'

export function fluxChecks(): CheckSpec[] {
  return [
    {
      id: 'flux-probe',
      label: 'Paint probes',
      run: async () => {
        const { fluxSummary } = await import('../../../integrations/media-flux/fluxProbe.js')
        const sum = fluxSummary()
        if (!sum.enabled) {
          return {
            status: 'info' as const,
            evidence: 'probe off (opt-in) — MERCURY_FLUX_PROBE=1 arms the local frame/latency probe; laws gate-enforced (scripts/streaming/)',
          }
        }
        const risk = sum.counters['stale-frame-risk'] ?? 0
        return {
          status: risk === 0 ? ('ok' as const) : ('fail' as const),
          evidence: `armed · frames ${sum.frames.total} (p50 ${sum.frames.p50.toFixed(1)}ms · p95 ${sum.frames.p95.toFixed(1)}ms · max ${sum.frames.maxMs.toFixed(0)}ms) · patches ${sum.counters['patches'] ?? 0} · stale-frame-risk ${risk}`,
          ...(risk > 0 ? { fix: 'A probe observed unexpected screen writes — report this.' } : {}),
        }
      },
    },
  ]
}
