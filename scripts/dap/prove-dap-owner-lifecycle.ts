#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-dap-owner-lifecycle.ts
//  ORACLE: debug sessions are owner-addressed, event-driven, and torn down on
//  owner lifecycle end (slice-4 invariants, flipped from the slice-0 pins) —
//  all against the deterministic mock adapter.
//
//  Proven here:
//   · two conversations each use alias 'main' WITHOUT collision;
//   · a same-owner re-launch on the alias replaces only that owner's session;
//   · a missing-session op is a TYPED failure (effect outcome 'failed' — the
//     chokepoint maps it to a model-visible tool error);
//   · waitForStopOutcome is event-driven with deadline+abort (no poll loop)
//     and leaves zero waiters;
//   · owner disposal (the ONE lifecycle registry) reaps the owner's whole
//     fleet — child gone, registry empty; the other owner untouched;
//   · breakpoints report adapter-VERIFIED detail.
//
//  Run:  ~/.bun/bin/bun run scripts/dap/prove-dap-owner-lifecycle.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, '..', '..')
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mock: { command: process.execPath, args: [MOCK] },
  })
  delete process.env.MERCURY_DAP

  const dap = await import('../../src/services/dap/dapClient.js')
  const ok = await import('../../src/services/run/ownerKey.js')
  const lifecycle = await import('../../src/services/run/ownerLifecycle.js')

  const A = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'conv-A', lane: 'main' })
  const B = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'conv-B', lane: 'main' })

  section("1. two conversations' alias 'main' do NOT collide")
  {
    const a = await dap.createDapSession({
      owner: A,
      id: 'main',
      adapterKey: 'mock',
      program: '/tmp/a.py',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/a.py', [3]]]),
    })
    const aStop = await a.waitForStopOutcome(5_000)
    check('A stopped at its breakpoint (event-driven)', aStop.state === 'stopped' && aStop.state === 'stopped' && aStop.info.reason === 'breakpoint')
    const b = await dap.createDapSession({
      owner: B,
      id: 'main',
      adapterKey: 'mock',
      program: '/tmp/b.py',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/b.py', [3]]]),
    })
    check("B's 'main' did NOT dispose A's live debugger", a.terminated === false)
    check(
      'each owner resolves its OWN session',
      dap.getDapSession(A, 'main') === a && dap.getDapSession(B, 'main') === b,
    )
    check(
      "each owner's listing shows only its own fleet",
      dap.listDapSessions(A).length === 1 && dap.listDapSessions(B).length === 1,
    )
    check(
      'breakpoints carry adapter-VERIFIED detail',
      a.breakpoints.get('/tmp/a.py')?.[0]?.verified === true,
    )
    // Same-owner re-launch on the alias REPLACES that owner's session only.
    const a2 = await dap.createDapSession({
      owner: A,
      id: 'main',
      adapterKey: 'mock',
      program: '/tmp/a2.py',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/a2.py', [3]]]),
    })
    check("same-owner re-launch replaces A's session", a.terminated === true && dap.getDapSession(A, 'main') === a2)
    check("…and B's session survives untouched", b.terminated === false)

    // Owner disposal reaps A's whole fleet; B untouched.
    await lifecycle.disposeOwner(A)
    check('disposeOwner(A) reaps the fleet', dap.getDapSession(A, 'main') === undefined && a2.terminated === true)
    check('B untouched by A disposal', dap.getDapSession(B, 'main') === b && b.terminated === false)
    check('event waiters at zero', a2._stateWaiterCountForTesting() === 0)
    await dap.removeDapSession(B, 'main')
    check('registry drains to zero', dap._dapSessionCountForTesting() === 0)
  }

  section('2. failures are TYPED (never prose-as-success)')
  {
    const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
    const result = (await DebugTool.call(
      { op: 'stack', session: 'nonexistent' } as never,
      {} as never,
      undefined as never,
      undefined as never,
    )) as { data: { result: string; outcome: string }; effect?: { outcome: string } }
    check(
      "a missing-session op is a FAILED effect (chokepoint maps it to a tool error)",
      result.effect?.outcome === 'failed' && result.data.outcome === 'failed',
      JSON.stringify({ effect: result.effect?.outcome, data: result.data.outcome }),
    )
    check('the prose still names the problem', result.data.result.includes('no debug session'))
    const status = (await DebugTool.call({ op: 'status' } as never, {} as never, undefined as never, undefined as never)) as {
      effect?: { outcome: string }
    }
    check("status with no sessions is a 'no-change' observation", status.effect?.outcome === 'no-change')
  }

  section('3. the poll loop is gone (structural pin)')
  {
    const src = readFileSync(join(root, 'src/services/dap/dapClient.ts'), 'utf8')
    check('no 25ms poll remains', !src.includes('setTimeout(res, 25)'))
    check('event-driven waiter present', src.includes('waitForStopOutcome') && src.includes('#stateWaiters'))
    check('process-exit sweep sync-kills survivors', src.includes("process.on('exit'"))
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
