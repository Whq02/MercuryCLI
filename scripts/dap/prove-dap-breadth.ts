#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-dap-breadth.ts — the C2 additions (parity spec 04),
//  deterministic against mock-dap-adapter-2:
//    A. the adapter config FILE: rows resolve (env > file > builtin
//       precedence), list in knownAdapterKeys, and drive extension auto-pick
//    P. attach by port/host: the flat body carries {port, host}; the
//       debugpy 'connect' spelling nests it; a bare-port attach auto-picks
//       the python adapter at the permission gate
//    T. tcp connect mode: `${port}` is substituted with a free loopback
//       port, the spawned server is dialed, and the whole dance (initialize
//       → breakpoints → stop → threads) runs over the socket
//    C. conditional-breakpoint verification honesty: parseable conditions
//       verify; garbage is UNVERIFIED with the adapter's reason; the
//       unadvertised hit-count feature refuses precisely BEFORE sending
//    S. a never-stopping continue returns the still-running NORMAL result
//    X. op customRequest round-trips raw bodies
//
//  Run: ~/.bun/bin/bun run scripts/dap/prove-dap-breadth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')
const mock2 = path.join(repo, 'scripts/dap/mock-dap-adapter-2.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — breadth proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const scratch = mkdtempSync(path.join(tmpdir(), 'dap-breadth-'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'dap-breadth-home-'))
const adaptersFile = path.join(scratch, 'dap-adapters.json')
writeFileSync(
  adaptersFile,
  JSON.stringify({
    mock2: {
      command: process.execPath,
      args: [mock2],
      fileTypes: ['.m2'],
      rootMarkers: ['mock2.toml'],
      attachShape: 'flat',
      attachDefaults: { flavor: 'file-row' },
    },
    mock2tcp: {
      command: process.execPath,
      args: [mock2, '${port}'],
      connect: 'tcp',
      fileTypes: ['.m2t'],
    },
    mock2connect: {
      command: process.execPath,
      args: [mock2],
      attachShape: 'connect',
    },
  }),
)
process.env.MERCURY_DAP_ADAPTERS_FILE = adaptersFile

const { resolveAdapter, knownAdapterKeys, adapterKeyForExtension, createDapSession, removeDapSession, _dapSessionCountForTesting } =
  await import('../../src/services/dap/dapClient.ts')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const owner = processMainOwner()

async function runOp(input: Record<string, unknown>) {
  const result = await (DebugTool as { call: Function }).call(input, {
    owner,
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: {} }),
  })
  return result as { data: { result: string; outcome: string; debuggee?: string } }
}

console.log('— A. the adapter config file —')
{
  const row = resolveAdapter('mock2')
  check('file row resolves', row !== null && row.command === process.execPath && row.attachShape === 'flat', JSON.stringify(row))
  check('file rows list in knownAdapterKeys', knownAdapterKeys().includes('mock2') && knownAdapterKeys().includes('mock2tcp'))
  check('extension auto-pick reads the file table', adapterKeyForExtension('.m2') === 'mock2' && adapterKeyForExtension('.m2t') === 'mock2tcp')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ mock2: { command: '/env/wins', args: [] } })
  const overridden = resolveAdapter('mock2')
  check('the env table outranks the file table', overridden?.command === '/env/wins', JSON.stringify(overridden))
  delete process.env.MERCURY_DAP_ADAPTERS
  check('builtins still resolve beside the file', resolveAdapter('lldb') !== null)
}

console.log('— P. attach by port/host —')
{
  const r = await runOp({ op: 'attach', adapter: 'mock2', port: 45_678, host: '10.0.0.9', session: 'att' })
  check('attach-by-port succeeded with a typed stop', /attached to 10\.0\.0\.9:45678/.test(r.data.result) && r.data.debuggee === 'stopped', r.data.result.slice(0, 200))
  const echo = await runOp({ op: 'customRequest', session: 'att', method: 'mock/lastAttach' })
  check('the FLAT attach body carried port + host + the file-row defaults', /"port": 45678/.test(echo.data.result) && /"host": "10\.0\.0\.9"/.test(echo.data.result) && /"flavor": "file-row"/.test(echo.data.result), echo.data.result.slice(0, 300))
  await runOp({ op: 'disconnect', session: 'att' })

  const r2 = await runOp({ op: 'attach', adapter: 'mock2connect', port: 5_678, session: 'att2' })
  check('connect-shaped attach succeeded', r2.data.debuggee === 'stopped', r2.data.result.slice(0, 160))
  const echo2 = await runOp({ op: 'customRequest', session: 'att2', method: 'mock/lastAttach' })
  check('the debugpy spelling nests {connect:{host,port}}', /"connect": \{/.test(echo2.data.result) && /"port": 5678/.test(echo2.data.result), echo2.data.result.slice(0, 300))
  await runOp({ op: 'disconnect', session: 'att2' })

  const perm = await (DebugTool as { checkPermissions: Function }).checkPermissions({ op: 'attach', port: 5005 })
  check('a bare-port attach auto-picks the python adapter at the gate', perm.behavior === 'ask' && /adapter python/.test(perm.message), JSON.stringify(perm))
}

console.log('— T. tcp connect with a substituted port —')
{
  const program = path.join(scratch, 'demo.m2t')
  writeFileSync(program, 'x\n')
  const r = await runOp({ op: 'launch', program, file: program, lines: [3], session: 'tcp' })
  check('tcp launch reached the first stop over the socket', r.data.debuggee === 'stopped' && /via mock2tcp/.test(r.data.result), r.data.result.slice(0, 220))
  const argv = await runOp({ op: 'customRequest', session: 'tcp', method: 'mock/argv' })
  const portMatch = argv.data.result.match(/"(\d{2,5})"/)
  check('the adapter received a REAL substituted port, not the token', portMatch !== null && Number(portMatch![1]) > 0 && !argv.data.result.includes('${port}'), argv.data.result.slice(0, 200))
  await runOp({ op: 'disconnect', session: 'tcp' })
}

console.log('— C. conditional-breakpoint honesty —')
{
  const program = path.join(scratch, 'demo2.m2')
  writeFileSync(program, 'x\n')
  await runOp({ op: 'launch', program, session: 'cond', file: program, lines: [1] })
  const good = await runOp({ op: 'breakpoints', session: 'cond', file: program, breakpoints: [{ line: 4, condition: 'x == 4' }] })
  check('a parseable condition VERIFIES', /line 4: verified/.test(good.data.result), good.data.result.slice(0, 160))
  const bad = await runOp({ op: 'breakpoints', session: 'cond', file: program, breakpoints: [{ line: 5, condition: 'garbage(' }] })
  check("an unparseable condition is UNVERIFIED with the adapter's reason", /line 5: UNVERIFIED \(unparseable condition/.test(bad.data.result), bad.data.result.slice(0, 200))
  const hit = await runOp({ op: 'breakpoints', session: 'cond', file: program, breakpoints: [{ line: 6, hitCondition: '3' }] })
  check('the unadvertised hit-count feature refuses PRECISELY before sending', /does not support hit-count breakpoints/.test(hit.data.result), hit.data.result.slice(0, 200))
  await runOp({ op: 'disconnect', session: 'cond' })
}

console.log('— S. the still-running NORMAL result —')
{
  process.env.MOCK2_NEVER_STOP = '1'
  const program = path.join(scratch, 'demo3.m2')
  writeFileSync(program, 'x\n')
  await runOp({ op: 'launch', program, session: 'run' })
  const r = await runOp({ op: 'continue', session: 'run' })
  check('a never-stopping continue returns still-running (succeeded, debuggee running)', r.data.outcome === 'succeeded' && r.data.debuggee === 'running' && /still running after 10s/.test(r.data.result), `${r.data.outcome}/${r.data.debuggee}: ${r.data.result.slice(0, 160)}`)
  await runOp({ op: 'disconnect', session: 'run' })
  delete process.env.MOCK2_NEVER_STOP
}

console.log('— X. customRequest round-trips raw —')
{
  const program = path.join(scratch, 'demo4.m2')
  writeFileSync(program, 'x\n')
  await runOp({ op: 'launch', program, session: 'x' })
  const r = await runOp({ op: 'customRequest', session: 'x', method: 'mock/echo', body: JSON.stringify({ hello: [1, 2] }) })
  check('the echo carries the body verbatim', /"hello": \[\s*1,\s*2\s*\]/.test(r.data.result), r.data.result.slice(0, 200))
  const badBody = await runOp({ op: 'customRequest', session: 'x', method: 'mock/echo', body: '{nope' })
  check('malformed body JSON refuses typed', badBody.data.outcome === 'failed' && /not valid JSON/.test(badBody.data.result))
  await runOp({ op: 'disconnect', session: 'x' })
}

check('no sessions leaked', _dapSessionCountForTesting() === 0, String(_dapSessionCountForTesting()))
console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: attach/tcp/config-file/conditional/still-running/customRequest all hold')
