#!/usr/bin/env bun
// ============================================================================
//  prove-dap-launch-cwd — the standard launch body carries the session's
//  working directory, the one the adapter itself was started in
//  (release-hardening audit rank 33).
//
//  The gap: the standard launch body (python, lldb, gdb, netcoredbg, js,
//  go) substituted process.cwd() for the session's cwd, so after a cd
//  inside a Bash call, under a sub-agent's cwd override, or with a launch
//  profile declaring its own cwd, the adapter was spawned in the requested
//  directory while the debuggee was told to run in Mercury's startup
//  directory: ./data/input.csv was not found, ./out/ landed in the wrong
//  tree, and the same program worked from a shell. The attach arm and the
//  bespoke buildLaunchArgs arm already passed the right value.
//
//   L1 the launch body's cwd is the session's cwd, not the process's
//   L2 the adapter process and the debuggee agree on the directory
//   L3 the body still carries the rest of the standard shape (program,
//      args, stopOnEntry, noDebug, console)
//
//  Against the mock adapter's trace knob (the wire body is the witness).
//  PROVE_SRC names another checkout's src (the A/B control: L1 and L2 read
//  red at the pre-fix tree — the body carries the process directory).
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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

type TraceRow = { command: string; arguments: Record<string, unknown>; adapterCwd: string }
function readTrace(file: string): TraceRow[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as TraceRow)
}

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ mock: { command: process.execPath, args: [MOCK] } })
  delete process.env.MERCURY_DAP
  delete process.env.MOCK_DAP_TERMINATE_CAP
  const scratch = mkdtempSync(join(tmpdir(), 'dap-cwd-'))
  // The session's directory: realpath'd so the comparison survives a
  // symlinked temp root (macOS /var → /private/var).
  const sessionCwd = realpathSync(scratch)
  const trace = join(scratch, 'trace.jsonl')
  process.env.MOCK_DAP_TRACE = trace

  const { createDapSession, removeDapSession } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/run/ownerKey.ts'))
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-cwd-proof', lane: 'main' })

  console.log('============================================================')
  console.log(' DAP launch cwd (rank 33) — proof')
  console.log('============================================================')
  check('precondition: the session directory differs from the process directory', sessionCwd !== process.cwd())

  await createDapSession({
    owner: OWNER,
    id: 'cwd',
    adapterKey: 'mock',
    program: '/tmp/demo.py',
    args: ['--flag'],
    cwd: sessionCwd,
    stopOnEntry: true,
  })
  await removeDapSession(OWNER, 'cwd')
  const launch = readTrace(trace).find(row => row.command === 'launch')
  check('the launch went out', launch !== undefined)
  console.log('L1 the body carries the session cwd')
  check("the body's cwd is the session's directory", launch?.arguments.cwd === sessionCwd, String(launch?.arguments.cwd))
  check("the body's cwd is NOT the process directory", launch?.arguments.cwd !== process.cwd())
  console.log('L2 adapter and debuggee agree')
  check('the adapter process was started in the session directory', launch !== undefined && realpathSync(launch.adapterCwd) === sessionCwd, String(launch?.adapterCwd))
  check('the debuggee is told the directory the adapter runs in', launch !== undefined && realpathSync(launch.adapterCwd) === launch.arguments.cwd)
  console.log('L3 the rest of the standard shape stands')
  check('program', launch?.arguments.program === '/tmp/demo.py')
  check('args', JSON.stringify(launch?.arguments.args) === JSON.stringify(['--flag']))
  check('stopOnEntry', launch?.arguments.stopOnEntry === true)
  check('noDebug false by default', launch?.arguments.noDebug === false)
  check('console internalConsole', launch?.arguments.console === 'internalConsole')

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
