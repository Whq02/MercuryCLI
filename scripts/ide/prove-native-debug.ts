#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-native-debug.ts
//  PROOF: the slice-5 native-debugging expansion of the Debug tool —
//  against the deterministic mock-native-dap-adapter.mjs (full-caps and
//  --bare personas), zero real debuggers, gate-safe.
//
//  Contract proven here:
//   (1) GDB FALLBACK ROW — probed honesty via PATH shims: gdb 14+ registers
//       `gdb -i=dap`; gdb <14 stays ABSENT with the floor named; no gdb ⇒
//       absent. inferAdapter prefers the probed gdb only when lldb-dap is
//       off PATH.
//   (2) THE JOURNEY (full-caps mock, through DebugTool.call): launch with a
//       RICH conditional breakpoint (condition/hitCondition round-trip via
//       the adapter message echo) → stop → stack exposes [ip …] → function
//       breakpoints (verified + UNVERIFIED honesty) → disassemble (bounded)
//       → readMemory (bounded hex dump) → instruction-granularity step
//       (granularity actually passed — echoed in the stop description) →
//       restart → attach as a SECOND session (permissioned; first stop
//       reported) → plain-lines back-compat.
//   (3) PRECISE REFUSALS (--bare mock): every gated feature answers with
//       the exact unadvertised capability; restart's refusal names the
//       disconnect+relaunch path; launch-time rich breakpoints surface the
//       CAVEAT (they ride the dance before capabilities exist).
//   (4) TOOL SURFACE — attach asks permission like launch; disassemble/
//       readMemory are read-only; validateInput failures are typed.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-native-debug.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — proof exceeded 480s')
  process.exit(1)
}, 480_000)
guard.unref?.()

const MOCK = join(import.meta.dir, 'mock-native-dap-adapter.mjs')
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
  'native-mock': { command: process.execPath, args: [MOCK] },
  'bare-mock': { command: process.execPath, args: [MOCK, '--bare'] },
})
delete process.env.MERCURY_DAP

const dap = await import('../../src/services/dap/dapClient.js')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')

type CallOut = { data: { result: string; outcome: string; debuggee?: string } }
const call = async (input: Record<string, unknown>): Promise<CallOut> =>
  (await DebugTool.call(input as never, {} as never)) as CallOut

console.log('============================================================')
console.log(' native debugging (slice 5) — proof')
console.log('============================================================')

section('(1) the GDB fallback row — probed, never assumed')
{
  const savedPath = process.env.PATH
  const shimDir = mkdtempSync(join(tmpdir(), 'gdb-shim-'))
  const writeShim = (version: string): void => {
    const shim = join(shimDir, 'gdb')
    writeFileSync(shim, `#!/bin/sh\necho "GNU gdb (GDB) ${version}"\n`)
    chmodSync(shim, 0o755)
  }
  try {
    // No gdb anywhere: absent row.
    process.env.PATH = mkdtempSync(join(tmpdir(), 'empty-path-'))
    dap._resetGdbProbeForTesting()
    check('no gdb on PATH ⇒ probe not viable', dap.probeGdbDap().viable === false, dap.probeGdbDap().reason)
    check('…and no gdb adapter row', !dap.knownAdapterKeys().includes('gdb') && dap.resolveAdapter('gdb') === null)

    // gdb 14+: the row registers with the -i=dap spec.
    writeShim('14.2')
    process.env.PATH = shimDir
    dap._resetGdbProbeForTesting()
    const probe = dap.probeGdbDap()
    check('gdb 14.2 shim ⇒ probe viable with version', probe.viable === true && probe.version === '14.2', JSON.stringify(probe))
    const spec = dap.resolveAdapter('gdb')
    check('gdb row registers as `gdb -i=dap`', spec?.command === 'gdb' && spec.args.join(' ') === '-i=dap', JSON.stringify(spec))
    check('installHint names the DAP floor', (spec?.installHint ?? '').includes('14+'), spec?.installHint)
    check('knownAdapterKeys carries gdb', dap.knownAdapterKeys().includes('gdb'))
    // inferAdapter: native program + no lldb-dap on PATH ⇒ gdb (observable
    // through the permission message — the same inference the launch uses).
    const perm = await DebugTool.checkPermissions({ op: 'launch', program: '/tmp/demo' } as never, {} as never)
    check('inferAdapter prefers probed gdb when lldb-dap is absent', perm.behavior === 'ask' && 'message' in perm && String(perm.message).includes('(adapter gdb)'), JSON.stringify(perm))

    // gdb <14: predates -i=dap — the row must NOT register, reason names the floor.
    writeShim('12.1')
    dap._resetGdbProbeForTesting()
    const old = dap.probeGdbDap()
    check('gdb 12.1 shim ⇒ NOT viable, reason names the 14+ floor', old.viable === false && (old.reason ?? '').includes('14+'), JSON.stringify(old))
    check('…and no adapter row', dap.resolveAdapter('gdb') === null && !dap.knownAdapterKeys().includes('gdb'))
  } finally {
    process.env.PATH = savedPath
    dap._resetGdbProbeForTesting()
    rmSync(shimDir, { recursive: true, force: true })
  }
}

section('(2) the journey — full-caps mock through the REAL Debug tool')
{
  const launch = await call({
    op: 'launch',
    adapter: 'native-mock',
    program: '/tmp/demo.c',
    file: '/tmp/demo.c',
    breakpoints: [{ line: 4, condition: 'i == 3', hitCondition: '2' }],
    session: 'native',
  })
  check('launch with a RICH breakpoint stops (verified)', /line 4 verified/.test(launch.data.result) && /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
  check('…no capability caveat (the mock advertises everything)', !launch.data.result.includes('CAVEAT'), launch.data.result)

  const bps = await call({
    op: 'breakpoints',
    session: 'native',
    file: '/tmp/demo.c',
    breakpoints: [{ line: 4, condition: 'i == 3' }, { line: 9, logMessage: 'hit {x}' }],
  })
  check('rich fields round-trip to the adapter (condition echoed)', bps.data.result.includes('cond:i == 3'), bps.data.result)
  check('…and the logpoint too', bps.data.result.includes('log:hit {x}'), bps.data.result)

  const plain = await call({ op: 'breakpoints', session: 'native', file: '/tmp/demo.c', lines: [4] })
  check('plain lines stay back-compatible', plain.data.result.includes('line 4: verified'), plain.data.result)

  const stack = await call({ op: 'stack', session: 'native' })
  check('stack exposes the instruction pointer reference', stack.data.result.includes('[ip 0xdead0000]'), stack.data.result.split('\n')[0])

  const fbp = await call({ op: 'functionBreakpoints', session: 'native', functions: ['compute', 'ghost'] })
  check('function breakpoints: verified + UNVERIFIED honesty', fbp.data.result.includes('compute: verified') && fbp.data.result.includes('ghost: UNVERIFIED'), fbp.data.result)

  const disasm = await call({ op: 'disassemble', session: 'native', memoryReference: '0xdead0000', instructionCount: 3 })
  check('disassemble decodes at the frame ip (bounded)', disasm.data.result.includes('0xdead0000: push rbp') && disasm.data.result.split('\n').length <= 3, disasm.data.result)

  const mem = await call({ op: 'readMemory', session: 'native', memoryReference: '0xdead0000', count: 20 })
  check('readMemory hex-dumps with ascii gutter', mem.data.result.includes('20 bytes') && mem.data.result.includes('MERCURY-NATIVE-D'), mem.data.result)

  const step = await call({ op: 'next', session: 'native', granularity: 'instruction' })
  check('instruction step passes granularity to the adapter (echoed)', step.data.result.includes('step(instruction)'), step.data.result.split('\n')[0])
  const stepDefault = await call({ op: 'stepIn', session: 'native' })
  check('default step stays statement-granularity', stepDefault.data.result.includes('step(statement)'), stepDefault.data.result.split('\n')[0])

  const restart = await call({ op: 'restart', session: 'native' })
  check('restart re-runs and reports the fresh stop', restart.data.result.includes('restart: stopped') && restart.data.result.includes('restarted'), restart.data.result.split('\n')[0])

  const disc = await call({ op: 'disconnect', session: 'native' })
  check('disconnect reaps', disc.data.result.includes('disconnected'))

  // attach — a separate session, first stop reported.
  const attach = await call({ op: 'attach', adapter: 'native-mock', pid: 4242, session: 'attached' })
  check('attach joins and reports the first stop (reason attach)', /attached to pid 4242 via native-mock/.test(attach.data.result) && /reason attach/.test(attach.data.result), attach.data.result.split('\n')[0])
  const disc2 = await call({ op: 'disconnect', session: 'attached' })
  check('attached session disconnects clean', disc2.data.result.includes('disconnected'))
}

section('(3) precise refusals — the --bare mock advertises nothing')
{
  const launch = await call({
    op: 'launch',
    adapter: 'bare-mock',
    program: '/tmp/demo.c',
    file: '/tmp/demo.c',
    breakpoints: [{ line: 4, condition: 'i == 3' }],
    session: 'bare',
  })
  check('launch-time rich breakpoint surfaces the CAVEAT (dance precedes capabilities)', launch.data.result.includes('CAVEAT') && launch.data.result.includes('supportsConditionalBreakpoints'), launch.data.result.split('\n')[0])

  const cases: Array<{ label: string; input: Record<string, unknown>; capability: string }> = [
    { label: 'conditional breakpoint', input: { op: 'breakpoints', file: '/tmp/demo.c', breakpoints: [{ line: 4, condition: 'x > 1' }] }, capability: 'supportsConditionalBreakpoints' },
    { label: 'hit-count breakpoint', input: { op: 'breakpoints', file: '/tmp/demo.c', breakpoints: [{ line: 4, hitCondition: '3' }] }, capability: 'supportsHitConditionalBreakpoints' },
    { label: 'logpoint', input: { op: 'breakpoints', file: '/tmp/demo.c', breakpoints: [{ line: 4, logMessage: 'x={x}' }] }, capability: 'supportsLogPoints' },
    { label: 'functionBreakpoints', input: { op: 'functionBreakpoints', functions: ['compute'] }, capability: 'supportsFunctionBreakpoints' },
    { label: 'disassemble', input: { op: 'disassemble', memoryReference: '0xdead0000' }, capability: 'supportsDisassembleRequest' },
    { label: 'readMemory', input: { op: 'readMemory', memoryReference: '0xdead0000' }, capability: 'supportsReadMemoryRequest' },
    { label: 'instruction step', input: { op: 'next', granularity: 'instruction' }, capability: 'supportsSteppingGranularity' },
    { label: 'restart', input: { op: 'restart' }, capability: 'supportsRestartRequest' },
  ]
  for (const c of cases) {
    const out = await call({ ...c.input, session: 'bare' })
    check(`${c.label} ⇒ refusal names ${c.capability}`, out.data.result.includes(c.capability) && out.data.outcome === 'no-change', out.data.result)
  }
  const restart = await call({ op: 'restart', session: 'bare' })
  check('restart refusal names the disconnect+relaunch path', restart.data.result.includes('disconnect') && restart.data.result.includes('launch'), restart.data.result)

  // Plain lines never gate on the bare adapter.
  const plain = await call({ op: 'breakpoints', session: 'bare', file: '/tmp/demo.c', lines: [4] })
  check('plain-line breakpoints never gate', plain.data.result.includes('line 4: verified'), plain.data.result)

  await call({ op: 'disconnect', session: 'bare' })
}

section('(4) tool surface — permissions, read-only matrix, validateInput')
{
  const attachPerm = await DebugTool.checkPermissions({ op: 'attach', pid: 123 } as never, {} as never)
  check('attach asks permission (Bash-class, like launch)', attachPerm.behavior === 'ask' && 'message' in attachPerm && String(attachPerm.message).includes('pid 123'))
  const restartPerm = await DebugTool.checkPermissions({ op: 'restart' } as never, {} as never)
  check('restart rides the permitted session', restartPerm.behavior === 'allow')
  check('disassemble is read-only', DebugTool.isReadOnly({ op: 'disassemble' } as never) === true)
  check('readMemory is read-only', DebugTool.isReadOnly({ op: 'readMemory' } as never) === true)
  check('attach is NOT read-only', DebugTool.isReadOnly({ op: 'attach' } as never) === false)
  check('functionBreakpoints is NOT read-only', DebugTool.isReadOnly({ op: 'functionBreakpoints' } as never) === false)

  const badAttach = await DebugTool.validateInput?.({ op: 'attach' } as never, {} as never)
  check('validateInput: attach without pid/program fails', badAttach?.result === false)
  const badDisasm = await DebugTool.validateInput?.({ op: 'disassemble' } as never, {} as never)
  check('validateInput: disassemble without memoryReference fails', badDisasm?.result === false)
  const badFbp = await DebugTool.validateInput?.({ op: 'functionBreakpoints' } as never, {} as never)
  check('validateInput: functionBreakpoints without functions fails', badFbp?.result === false)
  const richOk = await DebugTool.validateInput?.({ op: 'breakpoints', file: '/tmp/x.c', breakpoints: [{ line: 1 }] } as never, {} as never)
  check('validateInput: rich breakpoints satisfy the file+set requirement', richOk?.result === true)

  check('no leaked sessions after the journeys', dap._dapSessionCountForTesting() === 0, String(dap._dapSessionCountForTesting()))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ALL NATIVE-DEBUG CHECKS PASS')
  process.exit(0)
}
console.log(` ${failures} CHECK(S) FAILED`)
process.exit(1)
