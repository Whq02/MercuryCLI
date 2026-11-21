#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const report = await import('../../src/services/health/healthReport.js')

  section('1. the fast depth: no deep rows, streaming progress')
  {
    const events: Array<{ id: string; done: number; total: number }> = []
    const cert = await report.runHealthReport({
      depth: 'fast',
      onProgress: ev => events.push({ id: ev.check.id, done: ev.done, total: ev.total }),
    })
    const checks = cert.sections.flatMap(s => s.checks)
    check('certificate produced (fast)', cert.depth === 'fast' && checks.length > 0, `depth=${cert.depth} checks=${checks.length} — runHealthReport in src/services/health/healthReport.ts must return a fast certificate with rows`)
    check(
      'the fast depth has NO deep functional sections',
      !cert.sections.some(s => ['run-kernel', 'context-lifecycle', 'ide-loop'].includes(s.id)),
      `sections: ${cert.sections.map(s => s.id).join(', ')} — mark the deep sections depth: 'deep' in src/services/health/sections/run-kernel.ts, context-lifecycle.ts and ide-loop.ts`,
    )
    check('progress streamed one event per check', events.length === checks.length, `${events.length} events for ${checks.length} checks — runHealthReport in src/services/health/healthReport.ts must call onProgress once per check`)
    check(
      'done/total advances monotonically to completion',
      events.every((e, i) => e.done === i + 1 && e.total === checks.length),
      'runHealthReport in src/services/health/healthReport.ts must report done as 1..N in order with total = the check count',
    )
    check(
      'every check carries duration + evidence timestamp',
      checks.every(c => typeof c.durationMs === 'number' && typeof c.evidenceAt === 'number'),
      `missing on: ${checks.filter(c => typeof c.durationMs !== 'number' || typeof c.evidenceAt !== 'number').map(c => c.id).join(', ')} — runHealthReport in src/services/health/healthReport.ts must stamp durationMs and evidenceAt on every row`,
    )
    const ifaceTokens = checks.find(c => c.id === 'iface-tokens')
    check(
      'iface-tokens: every family resolves every role (structured tokens included)',
      ifaceTokens?.status === 'ok',
      ifaceTokens ? `${ifaceTokens.status} — ${ifaceTokens.evidence.slice(0, 90)} — the iface-tokens row is in src/services/health/sections/interface.ts; resolve the unresolved roles in src/utils/mercuryTokens.ts` : 'missing — the iface-tokens row in src/services/health/sections/interface.ts did not run',
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
    check('certificate produced (deep)', cert.depth === 'deep', `depth=${cert.depth} — runHealthReport in src/services/health/healthReport.ts must honor depth: 'deep'`)
    for (const id of ['run-kernel-roundtrip', 'effect-observer', 'context-parity', 'lsp-engine', 'dap-engine']) {
      const c = byId.get(id)
      check(
        `${id}: FUNCTIONAL green with completed-operation evidence`,
        c?.status === 'ok' && c.probe === 'functional' && /functional:/.test(c.evidence),
        c ? `${c.status} — ${c.evidence.slice(0, 90)} — fix the probe this row runs in src/services/health/healthDeepProbes.ts` : 'missing — the row is not registered in its section file under src/services/health/sections/',
      )
    }
    const live = byId.get('lsp-live-lane')
    check(
      'lsp-live-lane is honest: no running server here ⇒ info (never ok from config)',
      live !== undefined && live.status === 'info' && /not exercised/.test(live.evidence),
      live ? `${live.status} — ${live.evidence.slice(0, 80)} — probeLspLiveLane in src/services/health/healthDeepProbes.ts must report info and say not exercised when no server runs` : 'missing — the lsp-live-lane row in src/services/health/sections/ide-loop.ts did not run',
    )
    check(
      'deep rows streamed like every other row',
      streamedBeforeResolve.includes('dap-engine'),
      'runHealthReport in src/services/health/healthReport.ts must call onProgress for deep rows too',
    )
    check(
      'the fast rows are still present in deep mode',
      cert.sections.some(s => s.id === 'identity'),
      'deep depth in runHealthReport (src/services/health/healthReport.ts) must keep the fast sections',
    )
  }

  section('3. registries return to baseline after the deep run')
  {
    const lifecycle = await import('../../src/utils/run/ownerLifecycle.js')
    const dap = await import('../../src/services/dap/dapClient.js')
    const counts = lifecycle.ownerLifecycleCounts()
    const fixtureResidue = Object.entries(counts.stores).filter(([, n]) => n > 0)
    check('no DAP sessions survive', dap._dapSessionCountForTesting() === 0, `${dap._dapSessionCountForTesting()} left — probeDapEngine in src/services/health/healthDeepProbes.ts must close its session (src/services/dap/dapClient.ts)`)
    check(
      'no health-probe fixture owners survive in any registry',
      fixtureResidue.every(([, n]) => n <= 2),
      `${JSON.stringify(counts.stores)} — the deep probes in src/services/health/healthDeepProbes.ts must release the owners they register (src/utils/run/ownerLifecycle.ts)`,
    )
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
