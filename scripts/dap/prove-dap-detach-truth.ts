#!/usr/bin/env bun
// ============================================================================
//  prove-dap-detach-truth — disposing a debug session ends a program Mercury
//  launched and leaves a program it attached to running (release-hardening
//  audit rank 32).
//
//  The gap: dispose() sent disconnect {terminateDebuggee: true} to every
//  adapter for every session, attach sessions included — the development
//  server or editor the operator attached to in order to watch it died on
//  detach, and the tool called that a success. The session never recorded
//  how it started and the adapter's supportTerminateDebuggee capability was
//  never read.
//
//   L1 a launched session records startMode 'launch' and its disconnect
//      carries terminateDebuggee:true when the adapter advertises the cap
//   L2 an attach-by-mode session records 'attach' and its disconnect
//      carries terminateDebuggee:false — the target is left running
//   L3 an adapter row whose startRequest is 'attach' (the rdbg/unity shape)
//      detaches the same way with no mode given
//   L4 an adapter that does not advertise supportTerminateDebuggee sees no
//      terminateDebuggee attribute at all, in either mode (the DAP contract:
//      unadvertised, the flag is ignored; the adapter's default ends a
//      launched program and detaches from an attached one)
//   L5 the Debug tool's disconnect receipt says "detached" with the target
//      running for an attach session, "terminated" for a launched one
//
//  Against the deterministic mock adapter with its trace knob (the wire
//  body is the witness). Zero network, zero real debuggers. PROVE_SRC names
//  another checkout's src (the A/B control: L1-L5 read red at the pre-fix
//  tree — no startMode, terminateDebuggee true everywhere).
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

type TraceRow = { command: string; arguments: Record<string, unknown>; adapterCwd: string }
const scratch = mkdtempSync(join(tmpdir(), 'dap-detach-'))
let traceSeq = 0
/** A fresh trace file per leg — the mock reads its env at spawn. */
function armTrace(): string {
  const file = join(scratch, `trace-${++traceSeq}.jsonl`)
  process.env.MOCK_DAP_TRACE = file
  return file
}
function readTrace(file: string): TraceRow[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as TraceRow)
}
const disconnectOf = (file: string): TraceRow | undefined => readTrace(file).find(row => row.command === 'disconnect')

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mock: { command: process.execPath, args: [MOCK] },
    mockattachrow: { command: process.execPath, args: [MOCK], startRequest: 'attach' },
  })
  delete process.env.MERCURY_DAP

  const { createDapSession, removeDapSession, getDapSession } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/run/ownerKey.ts'))
  const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-detach-proof', lane: 'main' })

  console.log('============================================================')
  console.log(' DAP detach truth (rank 32) — proof')
  console.log('============================================================')

  section('L1 a launched session ends its program on disconnect (cap advertised)')
  {
    process.env.MOCK_DAP_TERMINATE_CAP = '1'
    const trace = armTrace()
    const session = await createDapSession({ owner: OWNER, id: 'l1', adapterKey: 'mock', program: '/tmp/demo.py', cwd: process.cwd() })
    check('startMode records launch', session.startMode === 'launch', String(session.startMode))
    check('the adapter advertised supportTerminateDebuggee', session.capabilities?.supportTerminateDebuggee === true)
    await removeDapSession(OWNER, 'l1')
    const body = disconnectOf(trace)
    check('the disconnect went out', body !== undefined)
    check('terminateDebuggee is true for the launched program', body?.arguments.terminateDebuggee === true, JSON.stringify(body?.arguments))
  }

  section('L2 an attach session leaves its target running (cap advertised)')
  {
    process.env.MOCK_DAP_TERMINATE_CAP = '1'
    const trace = armTrace()
    const session = await createDapSession({ owner: OWNER, id: 'l2', adapterKey: 'mock', program: 'pid:4242', cwd: process.cwd(), mode: 'attach', pid: 4242 })
    check('startMode records attach', session.startMode === 'attach', String(session.startMode))
    const start = readTrace(trace).find(row => row.command === 'attach')
    check('the start request was attach with the pid', start !== undefined && start.arguments.pid === 4242, JSON.stringify(start?.arguments))
    await removeDapSession(OWNER, 'l2')
    const body = disconnectOf(trace)
    check('terminateDebuggee is false for the attached target', body?.arguments.terminateDebuggee === false, JSON.stringify(body?.arguments))
  }

  section("L3 an adapter row whose startRequest is 'attach' detaches too")
  {
    process.env.MOCK_DAP_TERMINATE_CAP = '1'
    const trace = armTrace()
    const session = await createDapSession({ owner: OWNER, id: 'l3', adapterKey: 'mockattachrow', program: '/tmp/demo.py', cwd: process.cwd() })
    check('startMode records attach from the row', session.startMode === 'attach', String(session.startMode))
    await removeDapSession(OWNER, 'l3')
    const body = disconnectOf(trace)
    check('terminateDebuggee is false for the row-attached target', body?.arguments.terminateDebuggee === false, JSON.stringify(body?.arguments))
  }

  section('L4 no advertised capability ⇒ no terminateDebuggee attribute, either mode')
  {
    delete process.env.MOCK_DAP_TERMINATE_CAP
    const launchTrace = armTrace()
    const launched = await createDapSession({ owner: OWNER, id: 'l4a', adapterKey: 'mock', program: '/tmp/demo.py', cwd: process.cwd() })
    check('the default mock surface does not advertise the cap', launched.capabilities?.supportTerminateDebuggee === undefined)
    await removeDapSession(OWNER, 'l4a')
    const launchBody = disconnectOf(launchTrace)
    check('launched: the disconnect went out', launchBody !== undefined)
    check('launched: no terminateDebuggee key', launchBody !== undefined && !('terminateDebuggee' in launchBody.arguments), JSON.stringify(launchBody?.arguments))
    const attachTrace = armTrace()
    await createDapSession({ owner: OWNER, id: 'l4b', adapterKey: 'mock', program: 'pid:7', cwd: process.cwd(), mode: 'attach', pid: 7 })
    await removeDapSession(OWNER, 'l4b')
    const attachBody = disconnectOf(attachTrace)
    check('attached: no terminateDebuggee key', attachBody !== undefined && !('terminateDebuggee' in attachBody.arguments), JSON.stringify(attachBody?.arguments))
  }

  section('L5 the Debug tool receipt names the detach')
  {
    process.env.MOCK_DAP_TERMINATE_CAP = '1'
    armTrace()
    const attached = (await DebugTool.call(
      { op: 'attach', adapter: 'mock', pid: 4242, file: '/tmp/demo.py', lines: [3] } as never,
      {} as never,
    )) as { data: { result: string } }
    check('the tool attached and saw the first stop', /attached to/.test(attached.data.result) && /stopped/.test(attached.data.result), attached.data.result.split('\n')[0])
    const detach = (await DebugTool.call({ op: 'disconnect' } as never, {} as never)) as {
      data: { result: string; debuggee?: string }
    }
    check('the receipt says detached, target running', detach.data.result.includes('detached') && detach.data.result.includes('keeps running'), detach.data.result)
    check('the structured debuggee word is running, not terminated', detach.data.debuggee === 'running', String(detach.data.debuggee))
    armTrace()
    const launched = (await DebugTool.call(
      { op: 'launch', adapter: 'mock', program: '/tmp/demo.py', file: '/tmp/demo.py', lines: [3] } as never,
      {} as never,
    )) as { data: { result: string } }
    check('the tool launched', /launched/.test(launched.data.result), launched.data.result.split('\n')[0])
    const ended = (await DebugTool.call({ op: 'disconnect' } as never, {} as never)) as {
      data: { result: string; debuggee?: string }
    }
    check('a launched program is reported terminated on disconnect', ended.data.result.includes('debuggee terminated') && ended.data.debuggee === 'terminated', ended.data.result)
    check('no session survives the proof', getDapSession(OWNER, 'l1') === undefined && getDapSession(OWNER, 'l4b') === undefined)
  }

  rmSync(scratch, { recursive: true, force: true })
  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED — ${checks} checks`)
    process.exit(1)
  }
  console.log(`✅ ALL PASS — ${checks} checks`)
  process.exit(0)
}

void main()
