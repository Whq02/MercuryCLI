import type { CheckSpec, HealthContext } from '../../healthReport.js'

export function contextLifecycleChecks(context: HealthContext): CheckSpec[] {
  const { probes } = context
  if (probes === null) return []
  return [
    {
      id: 'context-parity',
      label: 'Request-plan parity',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: () => probes.probeContextParity(),
    },
  ]
}
