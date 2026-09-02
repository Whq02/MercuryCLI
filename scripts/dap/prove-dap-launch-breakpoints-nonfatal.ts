#!/usr/bin/env bun
// ============================================================================
//  prove-dap-launch-breakpoints-nonfatal — a slow or refused launch-time
//  setBreakpoints round never aborts the launch (release-hardening audit
//  rank 70).
//
//  The gap: the launch awaited each setBreakpoints round bare, under the
//  generic 8s request deadline. An adapter that needed longer — symbol or
//  source-map resolution for a large native binary or bundle on a cold
//  cache — or that refused one source path aborted the whole launch:
//  configurationDone never sent, the session disposed and gone from the
//  registry, "launch failed: setBreakpoints timed out after 8000ms" beside
//  an output tail that showed nothing wrong, and no live session left for
//  op:"breakpoints" to retry the binding on. setBreakpointsTree, one screen
//  up, already caught per member and rang instead of failing.
//
//    L1 a refused round: the program launches, the lines are recorded
//       UNVERIFIED with the adapter's reason, the ring says so, the
//       session is live and op:"breakpoints" can retry
//    L2 a round answered after the generic deadline (9s): the launch
//       survives it and the breakpoints verify
//    L3 the tool's launch result names the unbound lines and the reason
//
//  Against the mock adapter's two new knobs. PROVE_SRC names another
//  checkout's src (the A/B control: L1-L3 read red at the pre-fix tree —
//  the launch fails).
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ mock: { command: process.execPath, args: [MOCK] } })
  delete process.env.MERCURY_DAP
  delete process.env.MOCK_DAP_REFUSE_BREAKPOINTS
  delete process.env.MOCK_DAP_BREAKPOINT_DELAY_MS

  const { createDapSession, getDapSession, removeDapSession } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/run/ownerKey.ts'))
  const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-bp-nonfatal', lane: 'main' })

  section('L1 a refused setBreakpoints round: the program still launches')
  {
    process.env.MOCK_DAP_REFUSE_BREAKPOINTS = '1'
    let session: { breakpoints: Map<string, Array<{ line: number; verified: boolean; message?: string }>>; output: string[]; alive: boolean } | undefined
    let error = ''
    try {
      session = (await createDapSession({
        owner: OWNER,
        id: 'refused',
        adapterKey: 'mock',
        program: '/tmp/demo.py',
        cwd: process.cwd(),
        breakpoints: new Map([['/tmp/demo.py', [3, 9]]]),
      })) as typeof session
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    check('the launch succeeded despite the refusal', session !== undefined, error)
    check('the session is registered and live', getDapSession(OWNER, 'refused') !== undefined && session?.alive === true)
    const rows = session?.breakpoints.get('/tmp/demo.py') ?? []
    check('the lines are recorded UNVERIFIED with the reason', rows.length === 2 && rows.every(r => r.verified === false && /no symbols loaded/.test(r.message ?? '')), JSON.stringify(rows))
    check('the ring says the round failed and the program runs without them', (session?.output ?? []).some(l => l.includes('breakpoints for /tmp/demo.py') && l.includes('program runs without them')), (session?.output ?? []).join(' | '))
    delete process.env.MOCK_DAP_REFUSE_BREAKPOINTS
    await removeDapSession(OWNER, 'refused')
  }

  section('L2 a round answered after the generic deadline: the launch survives it')
  {
    process.env.MOCK_DAP_BREAKPOINT_DELAY_MS = '9000'
    const t0 = Date.now()
    let error = ''
    let session: { breakpoints: Map<string, Array<{ line: number; verified: boolean }>> } | undefined
    try {
      session = (await createDapSession({
        owner: OWNER,
        id: 'slow',
        adapterKey: 'mock',
        program: '/tmp/demo.py',
        cwd: process.cwd(),
        breakpoints: new Map([['/tmp/demo.py', [3]]]),
      })) as typeof session
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const took = Date.now() - t0
    check('the launch waited the slow round out', session !== undefined && took >= 8_500, `${error} after ${took}ms`)
    check('the breakpoint verified once the adapter answered', (session?.breakpoints.get('/tmp/demo.py') ?? []).some(r => r.verified === true), JSON.stringify(session?.breakpoints.get('/tmp/demo.py')))
    delete process.env.MOCK_DAP_BREAKPOINT_DELAY_MS
    await removeDapSession(OWNER, 'slow')
  }

  section("L3 the tool's launch result names the unbound lines")
  {
    process.env.MOCK_DAP_REFUSE_BREAKPOINTS = '1'
    const launched = (await DebugTool.call(
      { op: 'launch', adapter: 'mock', program: '/tmp/demo.py', file: '/tmp/demo.py', lines: [3] } as never,
      {} as never,
    )) as { data: { result: string; outcome?: string } }
    check('the tool reports a launch, not a failure', /launched/.test(launched.data.result) && !/launch failed/.test(launched.data.result), launched.data.result.split('\n')[0])
    check('…naming the line UNVERIFIED with the reason', /UNVERIFIED/.test(launched.data.result) && /no symbols loaded/.test(launched.data.result), launched.data.result)
    delete process.env.MOCK_DAP_REFUSE_BREAKPOINTS
    await DebugTool.call({ op: 'disconnect' } as never, {} as never)
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL PASS')
  process.exit(0)
}

void main()
