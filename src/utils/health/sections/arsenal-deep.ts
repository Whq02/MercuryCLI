import type { CheckSpec, HealthContext } from '../../healthReport.js'

export function arsenalDeepChecks(context: HealthContext): CheckSpec[] {
  const { probes } = context
  if (probes === null) return []
  return [
    {
      id: 'structure-loop',
      label: 'Structural loop',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: () => probes.probeStructureLoop(),
    },
    {
      id: 'git-graph',
      label: 'Git work graph',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: () => probes.probeGitGraph(),
    },
    {
      id: 'journey-loop',
      label: 'Application journey',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 45_000,
      run: () => probes.probeJourneyLoop(),
    },
  ]
}
