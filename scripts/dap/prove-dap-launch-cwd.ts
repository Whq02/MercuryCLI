#!/usr/bin/env bun

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
  const sessionCwd = realpathSync(scratch)
  const trace = join(scratch, 'trace.jsonl')
  process.env.MOCK_DAP_TRACE = trace

  const { createDapSession, removeDapSession } = await import(join(SRC, 'integrations/debugger/dapClient.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'engine/run-owner/ownerKey.ts'))
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-cwd-proof', lane: 'main' })

  console.log('============================================================')
  console.log(' DAP launch cwd (rank 33) — proof')
  console.log('============================================================')
  check('precondition: the session directory differs from the process directory', sessionCwd !== process.cwd(), 'the proof needs a scratch directory other than the process directory; fix the mkdtempSync setup in this file')

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
  check('the launch went out', launch !== undefined, 'no launch request reached the trace of scripts/dap/mock-dap-adapter.mjs; createDapSession in src/integrations/debugger/dapClient.ts failed before session.launch')
  console.log('L1 the body carries the session cwd')
  check("the body's cwd is the session's directory", launch?.arguments.cwd === sessionCwd, String(launch?.arguments.cwd) + ' — the launch body is built in src/integrations/debugger/client/launch.ts and must take cwd from the session cwd given to createDapSession')
  check("the body's cwd is NOT the process directory", launch?.arguments.cwd !== process.cwd(), 'the launch body in src/integrations/debugger/client/launch.ts must carry the session cwd, not the process directory')
  console.log('L2 adapter and debuggee agree')
  check('the adapter process was started in the session directory', launch !== undefined && realpathSync(launch.adapterCwd) === sessionCwd, String(launch?.adapterCwd) + ' — the DapSession constructor in src/integrations/debugger/dapClient.ts must open the adapter transport in the session cwd')
  check('the debuggee is told the directory the adapter runs in', launch !== undefined && realpathSync(launch.adapterCwd) === launch.arguments.cwd, 'the adapter directory (DapSession in src/integrations/debugger/dapClient.ts) and the launch body cwd (src/integrations/debugger/client/launch.ts) must be the same directory')
  console.log('L3 the rest of the standard shape stands')
  check('program', launch?.arguments.program === '/tmp/demo.py', 'the launch body in src/integrations/debugger/client/launch.ts must carry program')
  check('args', JSON.stringify(launch?.arguments.args) === JSON.stringify(['--flag']), 'the launch body in src/integrations/debugger/client/launch.ts must carry args')
  check('stopOnEntry', launch?.arguments.stopOnEntry === true, 'the launch body in src/integrations/debugger/client/launch.ts must carry stopOnEntry')
  check('noDebug false by default', launch?.arguments.noDebug === false, 'the launch body in src/integrations/debugger/client/launch.ts must default noDebug to false')
  check('console internalConsole', launch?.arguments.console === 'internalConsole', 'the launch body in src/integrations/debugger/client/launch.ts must set console to internalConsole')

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
