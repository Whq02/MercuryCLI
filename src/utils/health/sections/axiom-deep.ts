import type { CheckSpec, HealthContext } from '../../healthReport.js'

export function axiomDeepChecks(context: HealthContext): CheckSpec[] {
  const { probes } = context
  if (probes === null) return []
  return [
    {
      id: 'axiom-primitives',
      label: 'Primitive journey',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: () => probes.probeAxiomPrimitives(),
    },
  ]
}
