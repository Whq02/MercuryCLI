#!/usr/bin/env bun
// ============================================================================
//  prove-dap-root-hosts-debuggee — a session tree whose root runs a program
//  of its own is terminated by the root's word, never by its children's
//  (release-hardening audit rank 34).
//
//  The gap: treeTerminated() reported the whole tree dead once every child
//  had ended — the js-debug rule, where the root is a bare server session
//  that never runs a program. debugpy's root hosts the main program and
//  opens a child session per subprocess: when a worker exited, every
//  continue/step/pause answered "debuggee terminated", evaluate labelled
//  its answer "[debuggee terminated]", while status still showed the root
//  running and the program sat at a breakpoint.
//
//   L1 a root that showed a debuggee of its own (process + thread events)
//      outlives its children: the tree is not terminated, a wait answers
//      timeout, the root's own continue ends it
//   L2 control: a pure server root (no debuggee of its own) dies with its
//      last child while its process lingers — the js-debug truth stands
//   L3 the worker scenario: the child stops, continues and exits while the
//      root program runs on; the next wait says running
//   L4 the Debug tool reads the root's state: status says running,
//      evaluate labels the debuggee running, the root's continue ends it
//
//  Against the multi-session mock in stdio mode (the debugpy shape) with
//  its MOCK_MULTI_ROOT_HOSTS knob. Zero network, zero real debuggers.
//  PROVE_SRC names another checkout's src (the A/B control: L1, L3 and L4
//  read red at the pre-fix tree).
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
async function waitFor(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(res => setTimeout(res, 20))
  }
  return cond()
}
function clearKnobs(): void {
  for (const knob of Object.keys(process.env)) {
    if (knob.startsWith('MOCK_MULTI_')) delete process.env[knob]
  }
}

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter-multi.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mockmultiStdio: { command: process.execPath, args: [MOCK] },
  })
  delete process.env.MERCURY_DAP
  clearKnobs()

  const { createDapSession, getDapSession, removeDapSession } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/run/ownerKey.ts'))
  const { ownerFromToolUseContext } = await import(join(SRC, 'services/run/resolveOwner.ts'))
  const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-root-hosts-proof', lane: 'main' })
  const TOOL_OWNER = ownerFromToolUseContext({})
  const callTool = async (input: Record<string, unknown>): Promise<{ result: string; debuggee?: string }> =>
    ((await DebugTool.call(input as never, {} as never)) as { data: { result: string; debuggee?: string } }).data

  console.log('============================================================')
  console.log(' DAP root hosts its own debuggee (rank 34) — proof')
  console.log('============================================================')

  section('L1 a root with a debuggee of its own outlives its children (the debugpy shape)')
  {
    process.env.MOCK_MULTI_ROOT_HOSTS = '1'
    const root = await createDapSession({ owner: OWNER, id: 'hosts', adapterKey: 'mockmultiStdio', program: '/tmp/demo.js', cwd: process.cwd() })
    check('the child was born and ran to completion', await waitFor(() => root.children.length === 1 && root.children[0]?.terminated === true))
    check('the root itself is not terminated', root.terminated === false)
    check('the tree is NOT terminated — the root hosts the main program', root.treeTerminated() === false)
    const outcome = await root.waitForStopOutcome(300)
    check('a wait answers timeout (still running), never terminated', outcome.state === 'timeout', outcome.state)
    await root.request('continue', { threadId: 1 })
    check("the root's own continue ends it — the tree terminates by the root's word", await waitFor(() => root.treeTerminated()))
    check('the root terminated itself', root.terminated === true)
    await removeDapSession(OWNER, 'hosts')
  }

  section('L2 control: a pure server root dies with its last child (the js-debug truth stands)')
  {
    clearKnobs()
    const server = await createDapSession({ owner: OWNER, id: 'server', adapterKey: 'mockmultiStdio', program: '/tmp/demo.js', cwd: process.cwd() })
    check('the child ran to completion', await waitFor(() => server.children.length === 1 && server.children[0]?.terminated === true))
    check('the tree reads terminated while the parent process lingers', (await waitFor(() => server.treeTerminated())) && server.terminated === false)
    await removeDapSession(OWNER, 'server')
  }

  section('L3 the worker scenario: the child stops, continues and exits while the root runs on')
  {
    process.env.MOCK_MULTI_ROOT_HOSTS = '1'
    const tree = await createDapSession({
      owner: OWNER,
      id: 'worker',
      adapterKey: 'mockmultiStdio',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const stop = await tree.waitForStopOutcome(10_000)
    check('the worker child stopped at its breakpoint', stop.state === 'stopped' && stop.session !== tree, stop.state)
    if (stop.state === 'stopped') {
      const worker = stop.session
      worker.lastStopped = null
      await worker.request('continue', { threadId: 11 })
      check('the worker exited', await waitFor(() => worker.terminated))
      check('the tree is still alive — the main program runs on', tree.treeTerminated() === false)
      const next = await tree.waitForStopOutcome(300)
      check('the next wait says running (timeout), not terminated', next.state === 'timeout', next.state)
    }
    await removeDapSession(OWNER, 'worker')
  }

  section("L4 the Debug tool reads the root's own state")
  {
    process.env.MOCK_MULTI_ROOT_HOSTS = '1'
    const launched = await callTool({ op: 'launch', adapter: 'mockmultiStdio', program: '/tmp/demo.js' })
    check('the tool launched (running)', /launched/.test(launched.result) && /running/.test(launched.result), launched.result.split('\n')[0])
    const toolRoot = getDapSession(TOOL_OWNER, 'main')
    check('the tool session is reachable by the tool owner', toolRoot !== undefined)
    check('its child ran to completion', await waitFor(() => toolRoot?.children.length === 1 && toolRoot.children[0]?.terminated === true))
    const status = await callTool({ op: 'status' })
    check('status: the root line says running', /session 'main'.*— running/.test(status.result), status.result)
    check('status: the child line says terminated', /child 'child-1'.*terminated/.test(status.result), status.result)
    const evald = await callTool({ op: 'evaluate', expression: 'a+b' })
    check('evaluate labels the debuggee running, never terminated', evald.result.includes('[debuggee running]'), evald.result)
    const cont = await callTool({ op: 'continue' })
    check("continue routes to the root and the root's own exit is the termination", cont.result.includes('debuggee terminated') && cont.debuggee === 'terminated', cont.result.split('\n')[0])
    const gone = await callTool({ op: 'disconnect' })
    check('disconnect reaps', gone.result.includes('disconnected'))
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED — ${checks} checks`)
    process.exit(1)
  }
  console.log(`✅ ALL PASS — ${checks} checks`)
  process.exit(0)
}

void main()
