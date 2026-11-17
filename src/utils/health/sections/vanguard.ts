import type { CheckSpec, HealthContext } from '../../healthReport.js'

export function vanguardChecks(context: HealthContext): CheckSpec[] {
  const { probes } = context
  if (probes === null) return []
  return [
    {
      id: 'change-transaction',
      label: 'Change transaction',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: () => probes.probeChangeTransaction(),
    },
    {
      id: 'service-lifecycle',
      label: 'Project services',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: () => probes.probeServiceLifecycle(),
    },
    {
      id: 'agent-envelope',
      label: 'Crewmate envelopes',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: () => probes.probeAgentEnvelope(),
    },
  ]
}
