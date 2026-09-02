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
