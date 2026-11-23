import type { CheckSpec } from '../healthReport.js'

export function runKernelChecks(): CheckSpec[] {
  return [
    {
      id: 'run-kernel-roundtrip',
      label: 'Run kernel',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: async () => (await import('../healthDeepProbes.js')).probeRunKernel(),
    },
    {
      id: 'effect-observer',
      label: 'Effect observer',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: async () => (await import('../healthDeepProbes.js')).probeEffectObserver(),
    },
  ]
}
