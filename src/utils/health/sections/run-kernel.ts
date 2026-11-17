import type { CheckSpec, HealthContext } from '../../healthReport.js'

export function runKernelChecks(context: HealthContext): CheckSpec[] {
  const { probes } = context
  if (probes === null) return []
  return [
    {
      id: 'run-kernel-roundtrip',
      label: 'Run kernel',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: () => probes.probeRunKernel(),
    },
    {
      id: 'effect-observer',
      label: 'Effect observer',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: () => probes.probeEffectObserver(),
    },
  ]
}
