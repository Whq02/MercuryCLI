import type { CheckSpec } from '../healthReport.js'

export function contextLifecycleChecks(): CheckSpec[] {
  return [
    {
      id: 'context-parity',
      label: 'Request-plan parity',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: async () => (await import('../healthDeepProbes.js')).probeContextParity(),
    },
  ]
}
