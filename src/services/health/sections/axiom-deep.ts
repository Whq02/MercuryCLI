import type { CheckSpec } from '../healthReport.js'

export function axiomDeepChecks(): CheckSpec[] {
  return [
    {
      id: 'axiom-primitives',
      label: 'Primitive journey',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: async () => (await import('../healthDeepProbes.js')).probeAxiomPrimitives(),
    },
  ]
}
