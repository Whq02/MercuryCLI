#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const report = await import('../../src/platform/health/healthReport.js')

  section('1. the fast depth: no deep rows, streaming progress')
  {
    const events: Array<{ id: string; done: number; total: number }> = []
    const cert = await report.runHealthReport({
      depth: 'fast',
      onProgress: ev => events.push({ id: ev.check.id, done: ev.done, total: ev.total }),
    })
    const checks = cert.sections.flatMap(s => s.checks)
    check(
      'certificate produced (fast)',
      cert.depth === 'fast' && checks.length > 0,
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so a fast run returns depth fast with at least one check row',
    )
    check(
      'the fast depth has NO deep functional sections',
      !cert.sections.some(s => ['run-kernel', 'context-lifecycle', 'ide-loop'].includes(s.id)),
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so rows whose depth is deep are skipped unless depth is deep',
    )
    check(
      'progress streamed one event per check',
      events.length === checks.length,
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so onProgress fires exactly once for every check row',
    )
    check(
      'done/total advances monotonically to completion',
      events.every((e, i) => e.done === i + 1 && e.total === checks.length),
      '',
      'change the onProgress call in runHealthReport (src/platform/health/healthReport.ts) so done counts 1..total in order',
    )
    check(
      'every check carries duration + evidence timestamp',
      checks.every(c => typeof c.durationMs === 'number' && typeof c.evidenceAt === 'number'),
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so every row gets durationMs and evidenceAt',
    )
    const ifaceTokens = checks.find(c => c.id === 'iface-tokens')
    check(
      'iface-tokens: every family resolves every role (structured tokens included)',
      ifaceTokens?.status === 'ok',
      ifaceTokens ? `${ifaceTokens.status} — ${ifaceTokens.evidence.slice(0, 90)}` : 'missing',
      'the iface-tokens row comes from src/platform/health/sections/interface.ts; read its evidence above and fix the family or role it names',
    )
  }

  section('2. deep mode: the functional probes COMPLETE real operations')
  {
    const streamedBeforeResolve: string[] = []
    const cert = await report.runHealthReport({
      depth: 'deep',
      onProgress: ev => streamedBeforeResolve.push(ev.check.id),
    })
    const checks = cert.sections.flatMap(s => s.checks)
    const byId = new Map(checks.map(c => [c.id, c]))
    check(
      'certificate produced (deep)',
      cert.depth === 'deep',
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so depth deep is kept on the certificate',
    )
    for (const id of ['run-kernel-roundtrip', 'effect-observer', 'context-parity', 'lsp-engine', 'dap-engine']) {
      const c = byId.get(id)
      check(
        `${id}: FUNCTIONAL green with completed-operation evidence`,
        c?.status === 'ok' && c.probe === 'functional' && /functional:/.test(c.evidence),
        c ? `${c.status} — ${c.evidence.slice(0, 90)}` : 'missing',
        'the deep rows are defined in src/platform/health/sections/run-kernel.ts, context-lifecycle.ts and ide-loop.ts; make this probe complete its operation and report probe functional with functional: evidence',
      )
    }
    const live = byId.get('lsp-live-lane')
    check(
      'lsp-live-lane is honest: no running server here ⇒ info (never ok from config)',
      live !== undefined && live.status === 'info' && /not exercised/.test(live.evidence),
      live ? `${live.status} — ${live.evidence.slice(0, 80)}` : 'missing',
      'change the lsp-live-lane row in src/platform/health/sections/ide-loop.ts so it reports info with not exercised evidence when no server runs',
    )
    check(
      'deep rows streamed like every other row',
      streamedBeforeResolve.includes('dap-engine'),
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so the deep pass also calls onProgress for each row',
    )
    check(
      'the fast rows are still present in deep mode',
      cert.sections.some(s => s.id === 'identity'),
      '',
      'change runHealthReport in src/platform/health/healthReport.ts so a deep run also runs the fast rows',
    )
  }

  section('3. registries return to baseline after the deep run')
  {
    const lifecycle = await import('../../src/engine/run-owner/ownerLifecycle.js')
    const dap = await import('../../src/integrations/debugger/dapClient.js')
    const counts = lifecycle.ownerLifecycleCounts()
    const fixtureResidue = Object.entries(counts.stores).filter(([, n]) => n > 0)
    check(
      'no DAP sessions survive',
      dap._dapSessionCountForTesting() === 0,
      '',
      'probeDapEngine in src/platform/health/healthDeepProbes.ts must close the DAP session it opens',
    )
    check(
      'no health-probe fixture owners survive in any registry',
      fixtureResidue.every(([, n]) => n <= 2),
      JSON.stringify(counts.stores),
      'a deep probe in src/platform/health/sections has left an owner registered; the store with the high count above names which registry in src/engine/run-owner/ownerLifecycle.ts to release it from',
    )
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
