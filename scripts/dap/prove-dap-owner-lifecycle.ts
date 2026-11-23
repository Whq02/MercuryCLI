#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

let failures = 0
let sectionHint = ''
const SECTION_HINTS: Record<string, string> = {
  '1': 'look at the owner-keyed registry in src/integrations/debugger/dapClient.ts (createDapSession, getDapSession, listDapSessions, removeDapSession: a session is keyed by owner and alias) and disposeOwner in src/engine/run-owner/ownerLifecycle.ts',
  '2': 'look at DebugTool.call in src/tools/debug/DebugTool.ts: a missing session must yield outcome failed, and status with no sessions a no-change effect',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, sectionHint].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  sectionHint = SECTION_HINTS[t.split('.')[0] ?? ''] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mock: { command: process.execPath, args: [MOCK] },
  })
  delete process.env.MERCURY_DAP

  const dap = await import('../../src/integrations/debugger/dapClient.js')
  const ok = await import('../../src/engine/run-owner/ownerKey.js')
  const lifecycle = await import('../../src/engine/run-owner/ownerLifecycle.js')

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
    const armed: number[] = []
    const arm = globalThis.setTimeout
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => { armed.push(ms ?? 0); return arm(fn, ms, ...rest) }) as unknown as typeof setTimeout
    const aStop = await a.waitForStopOutcome(5_000).finally(() => { globalThis.setTimeout = arm })
    check('A stopped at its breakpoint (event-driven)', aStop.state === 'stopped' && aStop.state === 'stopped' && aStop.info.reason === 'breakpoint')
    check('the wait for the stop asks for no pause: the only timer armed while it stands is its own deadline', armed.length <= 1 && armed.every(ms => ms === 5_000), `armed ${armed.join(', ') || 'none'}`)
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

    await lifecycle.disposeOwner(A)
    check('disposeOwner(A) reaps the fleet', dap.getDapSession(A, 'main') === undefined && a2.terminated === true)
    check('B untouched by A disposal', dap.getDapSession(B, 'main') === b && b.terminated === false)
    check('event waiters at zero', a2._stateWaiterCountForTesting() === 0)
    await dap.removeDapSession(B, 'main')
    check('registry drains to zero', dap._dapSessionCountForTesting() === 0)
  }

  section('2. failures are TYPED (never prose-as-success)')
  {
    const { DebugTool } = await import('../../src/tools/debug/DebugTool.js')
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


  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
