import type { CheckSpec } from '../healthReport.js'

export function arsenalDeepChecks(): CheckSpec[] {
  return [
    {
      id: 'structure-loop',
      label: 'Structural loop',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: async () => (await import('../healthDeepProbes.js')).probeStructureLoop(),
    },
    {
      id: 'git-graph',
      label: 'Git work graph',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: async () => (await import('../healthDeepProbes.js')).probeGitGraph(),
    },
    {
      id: 'journey-loop',
      label: 'Application journey',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 45_000,
      run: async () => (await import('../healthDeepProbes.js')).probeJourneyLoop(),
    },
  ]
}
