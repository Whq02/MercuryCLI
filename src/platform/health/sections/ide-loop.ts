import type { CheckSpec } from '../healthReport.js'

export function ideLoopChecks(): CheckSpec[] {
  return [
    {
      id: 'lsp-engine',
      label: 'LSP engine',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 20_000,
      run: async () => (await import('../healthDeepProbes.js')).probeLspEngine(),
    },
    {
      id: 'lsp-live-lane',
      label: 'LSP live lane',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 25_000,
      run: async () => (await import('../healthDeepProbes.js')).probeLspLiveLane(),
    },
    {
      id: 'dap-engine',
      label: 'DAP engine',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 30_000,
      run: async ctx => (await import('../healthDeepProbes.js')).probeDapEngine(ctx?.signal),
    },
    {
      id: 'python-debugger',
      label: 'Python debugger',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 45_000,
      run: async ctx => (await import('../healthDeepProbes.js')).probePythonDebugger(ctx?.signal),
    },
    {
      id: 'js-debugger',
      label: 'JS debugger boot',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 15_000,
      run: async ctx => (await import('../healthDeepProbes.js')).probeJsDebugBoot(ctx?.signal),
    },
  ]
}
