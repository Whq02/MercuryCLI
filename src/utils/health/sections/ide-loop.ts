import type { CheckSpec, HealthContext } from '../../healthReport.js'

export function ideLoopChecks(context: HealthContext): CheckSpec[] {
  const { probes } = context
  if (probes === null) return []
  return [
    {
      id: 'lsp-engine',
      label: 'LSP engine',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: () => probes.probeLspEngine(),
    },
    {
      id: 'lsp-live-lane',
      label: 'LSP live lane',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: () => probes.probeLspLiveLane(),
    },
    {
      id: 'dap-engine',
      label: 'DAP engine',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 30_000,
      run: ctx => probes.probeDapEngine(ctx?.signal),
    },
    {
      id: 'python-debugger',
      label: 'Python debugger',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 45_000,
      run: ctx => probes.probePythonDebugger(ctx?.signal),
    },
    {
      id: 'js-debugger',
      label: 'JS debugger boot',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: ctx => probes.probeJsDebugBoot(ctx?.signal),
    },
  ]
}
