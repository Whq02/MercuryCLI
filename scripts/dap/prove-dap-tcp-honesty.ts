#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-dap-tcp-honesty.ts — a tcp adapter that never binds is
//  reported as a TRANSPORT failure (FC-104). The precise diagnostic the
//  client composes — adapter never opened 127.0.0.1:<port> — could never
//  reach the operator: the first request's generic 8s timer always beat the
//  connect loop's own 8s deadline, so every dead-port adapter read
//  "initialize timed out … no evidence either way", a protocol diagnosis
//  for a transport failure pointing at the wrong subsystem.
//
//  Driven on the REAL client over an adapter that starts and never binds.
//
//  Run: ~/.bun/bin/bun run scripts/dap/prove-dap-tcp-honesty.ts
// ============================================================================
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'dap-tcp-honesty-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const scratch = mkdtempSync(path.join(tmpdir(), 'dap-tcp-honesty-'))
const adaptersFile = path.join(scratch, 'dap-adapters.json')
writeFileSync(
  adaptersFile,
  JSON.stringify({
    neverbind: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)', '${port}'],
      connect: 'tcp',
      fileTypes: ['.nvb'],
    },
  }),
)
process.env.MERCURY_DAP_ADAPTERS_FILE = adaptersFile

const { createDapSession, removeDapSession } = await import('../../src/services/dap/dapClient.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const program = path.join(scratch, 'probe.nvb')
writeFileSync(program, 'x')

const startedAt = Date.now()
let outcome = ''
try {
  await createDapSession({
    owner: processMainOwner(),
    id: 'tcp-honesty',
    adapterKey: 'neverbind',
    program,
    cwd: scratch,
  })
  outcome = 'session created (unexpected)'
} catch (error) {
  outcome = error instanceof Error ? error.message : String(error)
} finally {
  try {
    removeDapSession(processMainOwner(), 'tcp-honesty')
  } catch {
    /* nothing to remove on a refused create */
  }
}
const elapsed = Date.now() - startedAt
check(
  "the failure names the TRANSPORT: 'adapter never opened 127.0.0.1:<port>'",
  /adapter never opened 127\.0\.0\.1:\d+/.test(outcome),
  outcome.slice(0, 160),
)
check(
  'the generic protocol timeout never wins the race',
  !/initialize timed out/.test(outcome),
  outcome.slice(0, 120),
)
check(`the transport verdict lands inside the request window (${elapsed}ms < 8000ms)`, elapsed < 8000, String(elapsed))

console.log(failures === 0 ? '\nprove-dap-tcp-honesty: all green' : `\nprove-dap-tcp-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
