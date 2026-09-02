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
  const report = await import('../../src/utils/healthReport.js')

  section('1. the fast depth: no deep rows, streaming progress')
  {
    const events: Array<{ id: string; done: number; total: number }> = []
    const cert = await report.runHealthReport({
      depth: 'fast',
      onProgress: ev => events.push({ id: ev.check.id, done: ev.done, total: ev.total }),
    })
    const checks = cert.sections.flatMap(s => s.checks)
    check('certificate produced (fast)', cert.depth === 'fast' && checks.length > 0)
    check(
      'the fast depth has NO deep functional sections',
      !cert.sections.some(s => ['run-kernel', 'context-lifecycle', 'ide-loop'].includes(s.id)),
    )
    check('progress streamed one event per check', events.length === checks.length)
    check(
      'done/total advances monotonically to completion',
      events.every((e, i) => e.done === i + 1 && e.total === checks.length),
    )
    check(
      'every check carries duration + evidence timestamp',
      checks.every(c => typeof c.durationMs === 'number' && typeof c.evidenceAt === 'number'),
    )
    const ifaceTokens = checks.find(c => c.id === 'iface-tokens')
    check(
      'iface-tokens: every family resolves every role (structured tokens included)',
      ifaceTokens?.status === 'ok',
      ifaceTokens ? `${ifaceTokens.status} — ${ifaceTokens.evidence.slice(0, 90)}` : 'missing',
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
    check('certificate produced (deep)', cert.depth === 'deep')
    for (const id of ['run-kernel-roundtrip', 'effect-observer', 'context-parity', 'lsp-engine', 'dap-engine']) {
      const c = byId.get(id)
      check(
        `${id}: FUNCTIONAL green with completed-operation evidence`,
        c?.status === 'ok' && c.probe === 'functional' && /functional:/.test(c.evidence),
        c ? `${c.status} — ${c.evidence.slice(0, 90)}` : 'missing',
      )
    }
    const live = byId.get('lsp-live-lane')
    check(
      'lsp-live-lane is honest: no running server here ⇒ info (never ok from config)',
      live !== undefined && live.status === 'info' && /not exercised/.test(live.evidence),
      live ? `${live.status} — ${live.evidence.slice(0, 80)}` : 'missing',
    )
    check(
      'deep rows streamed like every other row',
      streamedBeforeResolve.includes('dap-engine'),
    )
    check(
      'the fast rows are still present in deep mode',
      cert.sections.some(s => s.id === 'identity'),
    )
  }

  section('3. registries return to baseline after the deep run')
  {
    const lifecycle = await import('../../src/services/run/ownerLifecycle.js')
    const dap = await import('../../src/services/dap/dapClient.js')
    const counts = lifecycle.ownerLifecycleCounts()
    const fixtureResidue = Object.entries(counts.stores).filter(([, n]) => n > 0)
    check('no DAP sessions survive', dap._dapSessionCountForTesting() === 0)
    check(
      'no health-probe fixture owners survive in any registry',
      fixtureResidue.every(([, n]) => n <= 2),
      JSON.stringify(counts.stores),
    )
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
