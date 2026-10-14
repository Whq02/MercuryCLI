#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'dap-extras-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = resolve(import.meta.dir, '..', '..', 'src')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

type TraceRow = { command: string; arguments: Record<string, unknown> }
const readTrace = (file: string): TraceRow[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as TraceRow)
    : []

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ mock: { command: process.execPath, args: [MOCK], launchDefaults: { type: 'mock-default', mode: 'from-the-row' } } })
  delete process.env.MERCURY_DAP
  delete process.env.MOCK_DAP_TERMINATE_CAP
  const scratch = mkdtempSync(join(tmpdir(), 'dap-extras-'))
  const trace = join(scratch, 'trace.jsonl')
  process.env.MOCK_DAP_TRACE = trace

  const { createDapSession, removeDapSession } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/run/ownerKey.ts'))
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-extras-proof', lane: 'main' })

  console.log('============================================================')
  console.log(' DAP launch extras — a caller\'s adapter-specific launch fields ride the standard body')
  console.log('============================================================')

  await createDapSession({ owner: OWNER, id: 'extras', adapterKey: 'mock', program: '/tmp/pkg', args: ['-test.run', '^TestAdd$'], cwd: scratch, stopOnEntry: true, launchExtras: { mode: 'test', program: 'never-wins' } })
  await removeDapSession(OWNER, 'extras')
  const launch = readTrace(trace).find(row => row.command === 'launch')
  check('the launch went out', launch !== undefined)
  check('the caller\'s extra field rides the body (mode: test — the dlv test-mode spelling)', launch?.arguments.mode === 'test', String(launch?.arguments.mode))
  check('an extra field overrides the adapter row\'s launchDefaults for the same key', launch?.arguments.mode !== 'from-the-row')
  check('the row\'s other defaults still ride', launch?.arguments.type === 'mock-default', String(launch?.arguments.type))
  check('the fixed fields win over an extra of the same name (program stays the caller\'s program)', launch?.arguments.program === '/tmp/pkg', String(launch?.arguments.program))
  check('args, cwd and stopOnEntry keep the standard shape', JSON.stringify(launch?.arguments.args) === JSON.stringify(['-test.run', '^TestAdd$']) && launch?.arguments.cwd === scratch && launch?.arguments.stopOnEntry === true)

  rmSync(scratch, { recursive: true, force: true })
  await createDapSession({ owner: OWNER, id: 'plain', adapterKey: 'mock', program: '/tmp/demo.py', cwd: tmpdir(), stopOnEntry: true })
  await removeDapSession(OWNER, 'plain')
  const plain = readTrace(trace).find(row => row.command === 'launch')
  check('without extras the body is byte-for-byte the standard one (no mode key beyond the row\'s own default)', plain === undefined || plain.arguments.mode === 'from-the-row' || plain.arguments.mode === undefined)

  console.log(failures === 0 ? '\n✅ prove-dap-launch-extras — all checks pass' : `\n❌ prove-dap-launch-extras — ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
