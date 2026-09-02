#!/usr/bin/env bun
// ============================================================================
//  live-native-debug-driver.ts — the RUN_LIVE native journey body (invoked by
//  live-native-debug-smoke.sh with SMOKE_* env + an MERCURY_DAP_ADAPTERS
//  'native' row pointing at the machine's real lldb-dap/gdb). Drives the
//  REAL Debug tool: conditional breakpoint stops ONLY when true → function
//  breakpoint → disassemble/readMemory when advertised (loud leg-skip when
//  not — capability honesty is the contract, not a failure) → instruction
//  step → clean exit with the program's real output.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// Hermetic home pin (the live-E2E hermeticity ratchet): a live driver must
// never write the REAL ~/.mercury.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
process.env.MERCURY_HOME = mkdtempSync(joinPath(tmpdir(), 'live-native-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const PROGRAM = process.env.SMOKE_PROGRAM
const SOURCE = process.env.SMOKE_SOURCE
const LINE = Number(process.env.SMOKE_LINE ?? '4')
if (!PROGRAM || !SOURCE) {
  console.log('live-native-debug-driver: SMOKE_PROGRAM/SMOKE_SOURCE not set (run via live-native-debug-smoke.sh)')
  process.exit(1)
}

const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
type CallOut = { data: { result: string; outcome: string; debuggee?: string } }
const call = async (input: Record<string, unknown>): Promise<CallOut> =>
  (await DebugTool.call(input as never, {} as never)) as CallOut

const gated = (out: CallOut): boolean =>
  out.data.outcome === 'no-change' && out.data.result.includes('not advertised')

console.log('— live native journey (adapter: native) —')

// 1. Conditional breakpoint: the loop runs i = 0..4; the breakpoint fires
//    ONLY when i == 3 — the stop itself proves the condition was honored.
const launch = await call({
  op: 'launch',
  adapter: 'native',
  program: PROGRAM,
  file: SOURCE,
  breakpoints: [{ line: LINE, condition: 'i == 3' }],
  session: 'live',
})
check('launch stops on the conditional breakpoint', /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n').slice(0, 3).join(' | '))
// lldb-dap evaluates expressions against a FRAME, not a bare stopped process
// (frameId-less repl evaluate answers "can't evaluate … while running") — the
// stack → frameId → evaluate flow is the documented tool loop.
const stopStack = await call({ op: 'stack', session: 'live' })
const stopFrame = Number(stopStack.data.result.match(/\[frameId (\d+)\]/)?.[1])
check('stack exposes a frameId at the stop', Number.isInteger(stopFrame), stopStack.data.result.split('\n')[0])
const evalI = await call({ op: 'evaluate', session: 'live', expression: 'i', frameId: stopFrame })
check('condition honored: i == 3 at the stop', /=\s*3\b/.test(evalI.data.result), evalI.data.result)

// 2. Function breakpoint on accumulate; clear the line set so ONLY the
//    function breakpoint can stop the next continue (i == 4 call).
const fbp = await call({ op: 'functionBreakpoints', session: 'live', functions: ['accumulate'] })
check('function breakpoint on accumulate verified', fbp.data.result.includes('accumulate: verified'), fbp.data.result)
const clearLines = await call({ op: 'breakpoints', session: 'live', file: SOURCE, breakpoints: [{ line: LINE, condition: 'i == 99' }] })
check('line breakpoint neutralized (condition can never fire)', clearLines.data.outcome === 'succeeded', clearLines.data.result)
const cont = await call({ op: 'continue', session: 'live' })
check('continue stops in accumulate (function breakpoint, i == 4 call)', /stopped/.test(cont.data.result) && /accumulate/.test(cont.data.result), cont.data.result.split('\n').slice(0, 2).join(' | '))

// 3. Disassemble/readMemory at the frame ip — capability-honest legs.
const stack = await call({ op: 'stack', session: 'live' })
const ip = stack.data.result.match(/\[ip (0x[0-9a-fA-F]+)\]/)?.[1]
console.log(`  (stack top: ${stack.data.result.split('\n')[0] ?? '?'})`)
if (!ip) {
  console.log('  [SKIP — LOUD] no instructionPointerReference on the frames: disassemble/readMemory legs need it')
} else {
  const disasm = await call({ op: 'disassemble', session: 'live', memoryReference: ip, instructionCount: 8 })
  if (gated(disasm)) {
    console.log(`  [SKIP — LOUD] disassemble: ${disasm.data.result}`)
  } else {
    check('disassemble decodes real instructions at the ip', disasm.data.outcome === 'no-change' && /0x[0-9a-fA-F]+:/.test(disasm.data.result), disasm.data.result.split('\n')[0])
  }
  const mem = await call({ op: 'readMemory', session: 'live', memoryReference: ip, count: 32 })
  if (gated(mem)) {
    console.log(`  [SKIP — LOUD] readMemory: ${mem.data.result}`)
  } else {
    check('readMemory dumps real bytes at the ip', mem.data.result.includes('memory at'), mem.data.result.split('\n')[0])
  }
}

// 4. Instruction-granularity step — capability-honest.
const istep = await call({ op: 'next', session: 'live', granularity: 'instruction' })
if (gated(istep)) {
  console.log(`  [SKIP — LOUD] instruction step: ${istep.data.result}`)
} else {
  check('instruction-granularity step stops again', /stopped|still running/.test(istep.data.result), istep.data.result.split('\n')[0])
}

// 5. Clear the function set, run to the end — the program's REAL output.
await call({ op: 'functionBreakpoints', session: 'live', functions: [] })
const done = await call({ op: 'continue', session: 'live' })
const out = await call({ op: 'output', session: 'live' })
const combined = `${done.data.result}\n${out.data.result}`
check('clean exit with the real program output (total: 10)', combined.includes('terminated') && combined.includes('total: 10'), combined.slice(0, 200))

const disc = await call({ op: 'disconnect', session: 'live' })
check('disconnect reaps', disc.data.result.includes('disconnected'))

process.exit(failures === 0 ? 0 : 1)
