import type { CheckSpec } from '../healthReport.js'

export function vanguardChecks(): CheckSpec[] {
  return [
    {
      id: 'change-transaction',
      label: 'Change transaction',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: async () => (await import('../healthDeepProbes.js')).probeChangeTransaction(),
    },
    {
      id: 'service-lifecycle',
      label: 'Project services',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: async () => (await import('../healthDeepProbes.js')).probeServiceLifecycle(),
    },
    {
      id: 'agent-envelope',
      label: 'Crewmate envelopes',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: async () => (await import('../healthDeepProbes.js')).probeCrewmateEnvelope(),
    },
  ]
}
