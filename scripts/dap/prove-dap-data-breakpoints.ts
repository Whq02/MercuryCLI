#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
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
  console.log('\nTIMEOUT — proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'dap-data-breakpoints-home-'))
const MOCK = join(import.meta.dir, 'mock-dap-adapter-memory.mjs')
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
  'memory-mock': { command: process.execPath, args: [MOCK] },
  'memory-bare': { command: process.execPath, args: [MOCK, '--bare'] },
})
delete process.env.MERCURY_DAP

const dap = await import('../../src/services/dap/dapClient.js')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
const { formatZodValidationError } = await import('../../src/utils/toolErrors.js')

type CallOut = { data: { result: string; outcome: string; debuggee?: string } }
const call = async (input: Record<string, unknown>): Promise<CallOut> => {
  try {
    return (await DebugTool.call(input as never, {} as never)) as CallOut
  } catch (err) {
    return { data: { result: `THREW: ${(err as Error).message}`, outcome: 'threw' } }
  }
}
const parse = (input: Record<string, unknown>): { ok: boolean; refusal: string } => {
  const r = DebugTool.inputSchema.safeParse(input)
  return r.success
    ? { ok: true, refusal: '' }
    : { ok: false, refusal: formatZodValidationError('Debug', r.error as never).replace(/\n/g, ' ') }
}
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')

console.log('============================================================')
console.log(' data + instruction breakpoints · writeMemory — proof')
console.log('============================================================')

section('(0) the schema knows the three ops')
{
  const cases: Array<[string, Record<string, unknown>]> = [
    ['dataBreakpoints', { op: 'dataBreakpoints', dataBreakpoints: [{ name: 'total', variablesReference: 100, accessType: 'write' }] }],
    ['instructionBreakpoints', { op: 'instructionBreakpoints', instructionBreakpoints: [{ instructionReference: '0x1000', offset: 4 }] }],
    ['writeMemory', { op: 'writeMemory', memoryReference: '0x2000', data: b64([42, 0, 0, 0]), allowPartial: 'false' }],
  ]
  for (const [op, input] of cases) {
    const r = parse(input)
    check(`op:"${op}" parses`, r.ok, r.refusal)
  }
  const badAccess = parse({ op: 'dataBreakpoints', dataBreakpoints: [{ name: 'total', variablesReference: 100, accessType: 'execute' }] })
  check('accessType is the DAP trio only (execute refused)', !badAccess.ok, badAccess.refusal)
  const quoted = DebugTool.inputSchema.safeParse({ op: 'instructionBreakpoints', instructionBreakpoints: [{ instructionReference: '0x1000', offset: '4' }] })
  check('instruction offset accepts a quoted integer', quoted.success && (quoted as { data?: { instructionBreakpoints?: Array<{ offset?: number }> } }).data?.instructionBreakpoints?.[0]?.offset === 4)
}

section('(1) the journey — the wrong value mid-computation, caught on its write')
{
  const launch = await call({ op: 'launch', adapter: 'memory-mock', program: '/tmp/demo.c', file: '/tmp/demo.c', lines: [4], session: 'mem' })
  check('launch stops at the line breakpoint', /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])

  const vars = await call({ op: 'variables', session: 'mem', variablesReference: 100 })
  check('variables expose the memory reference beside the value', /total = 0 \(int\) \[memory 0x2000\]/.test(vars.data.result), vars.data.result)

  const armed = await call({
    op: 'dataBreakpoints',
    session: 'mem',
    dataBreakpoints: [
      { name: 'total', variablesReference: 100, accessType: 'write' },
      { name: 'ghost', variablesReference: 100 },
    ],
  })
  check('the resolved variable is armed and verified', /total \(write\): verified/.test(armed.data.result) && armed.data.outcome === 'succeeded', `${armed.data.outcome}: ${armed.data.result}`)
  check("the unresolvable variable is named with the adapter's refusal", /ghost: refused by adapter \(no such variable ghost\)/.test(armed.data.result), armed.data.result)

  const state1 = await call({ op: 'customRequest', session: 'mem', method: 'mock/state' })
  check('setDataBreakpoints carried the dataId + accessType', /"dataId": "total@100"/.test(state1.data.result) && /"accessType": "write"/.test(state1.data.result), state1.data.result.slice(0, 300))

  const stop = await call({ op: 'continue', session: 'mem' })
  check('continue stops ON the write with the reason naming the variable', /reason data breakpoint \(write to total: 0 -> 7\)/.test(stop.data.result) && stop.data.debuggee === 'stopped', stop.data.result.split('\n')[0])

  const wrongAccess = await call({ op: 'dataBreakpoints', session: 'mem', dataBreakpoints: [{ name: 'label', variablesReference: 100, accessType: 'read' }] })
  check('an access type the adapter does not offer for that variable refuses precisely', /label \(read\): refused — adapter allows write/.test(wrongAccess.data.result) && wrongAccess.data.outcome === 'failed', `${wrongAccess.data.outcome}: ${wrongAccess.data.result}`)
  const state2 = await call({ op: 'customRequest', session: 'mem', method: 'mock/state' })
  check('…and the armed set stayed untouched (nothing was sent)', /"dataId": "total@100"/.test(state2.data.result), state2.data.result.slice(0, 300))

  const patched = await call({ op: 'writeMemory', session: 'mem', memoryReference: '0x2000', data: b64([42, 0, 0, 0]) })
  check('writeMemory reports the bytes written and the mutation', /writeMemory at 0x2000: 4 bytes written/.test(patched.data.result) && /debuggee state mutated/.test(patched.data.result) && patched.data.outcome === 'succeeded', `${patched.data.outcome}: ${patched.data.result}`)
  const readBack = await call({ op: 'readMemory', session: 'mem', memoryReference: '0x2000', count: 8 })
  check('readMemory reads the patched bytes back', /2a 00 00 00 4d 45 52 43/.test(readBack.data.result), readBack.data.result)
  const vars2 = await call({ op: 'variables', session: 'mem', variablesReference: 100 })
  check('the variable now shows the patched value', /total = 42 \(int\)/.test(vars2.data.result), vars2.data.result)

  const partial = await call({ op: 'writeMemory', session: 'mem', memoryReference: '0x2000', offset: 14, data: b64([1, 2, 3, 4]), allowPartial: true })
  check('allowPartial reports a partial write honestly', /writeMemory at 0x2000 \(offset 14\): 2 of 4 bytes written \(partial\)/.test(partial.data.result), partial.data.result)
  const refusedPartial = await call({ op: 'writeMemory', session: 'mem', memoryReference: '0x2000', offset: 14, data: b64([1, 2, 3, 4]) })
  check("without allowPartial the adapter's refusal is a typed failure", refusedPartial.data.outcome === 'failed' && /exceeds the writable region/.test(refusedPartial.data.result), `${refusedPartial.data.outcome}: ${refusedPartial.data.result}`)
  const badData = await call({ op: 'writeMemory', session: 'mem', memoryReference: '0x2000', data: 'not*base64' })
  check('malformed base64 refuses before reaching the adapter', badData.data.outcome === 'failed' && /base64/.test(badData.data.result), `${badData.data.outcome}: ${badData.data.result}`)

  const cleared = await call({ op: 'dataBreakpoints', session: 'mem', dataBreakpoints: [] })
  check('an empty set clears the data breakpoints', /data breakpoints cleared/.test(cleared.data.result), cleared.data.result)

  const ibp = await call({ op: 'instructionBreakpoints', session: 'mem', instructionBreakpoints: [{ instructionReference: '0x1000', offset: 4 }, { instructionReference: '0xbad' }] })
  check('instruction breakpoints: verified + UNVERIFIED honesty', /0x1000\+4: verified/.test(ibp.data.result) && /0xbad: UNVERIFIED \(no instruction at 0xbad\)/.test(ibp.data.result), ibp.data.result)
  const stop2 = await call({ op: 'continue', session: 'mem' })
  check('continue stops at the instruction reference', /reason instruction breakpoint \(at 0x1000\+4\)/.test(stop2.data.result), stop2.data.result.split('\n')[0])
  const clearedI = await call({ op: 'instructionBreakpoints', session: 'mem', instructionBreakpoints: [] })
  check('an empty set clears the instruction breakpoints', /instruction breakpoints cleared/.test(clearedI.data.result), clearedI.data.result)

  const done = await call({ op: 'continue', session: 'mem' })
  check('the program finishes with the patched total', /terminated/.test(done.data.result) && /total=42/.test(done.data.result), done.data.result)
  const disc = await call({ op: 'disconnect', session: 'mem' })
  check('disconnect reaps', /disconnected/.test(disc.data.result))
}

section('(2) precise refusals — the --bare persona advertises none of the three')
{
  await call({ op: 'launch', adapter: 'memory-bare', program: '/tmp/demo.c', file: '/tmp/demo.c', lines: [4], session: 'bare' })
  const cases: Array<{ label: string; input: Record<string, unknown>; capability: string }> = [
    { label: 'dataBreakpoints', input: { op: 'dataBreakpoints', dataBreakpoints: [{ name: 'total', variablesReference: 100 }] }, capability: 'supportsDataBreakpoints' },
    { label: 'instructionBreakpoints', input: { op: 'instructionBreakpoints', instructionBreakpoints: [{ instructionReference: '0x1000' }] }, capability: 'supportsInstructionBreakpoints' },
    { label: 'writeMemory', input: { op: 'writeMemory', memoryReference: '0x2000', data: b64([1]) }, capability: 'supportsWriteMemoryRequest' },
  ]
  for (const c of cases) {
    const out = await call({ ...c.input, session: 'bare' })
    check(`${c.label} ⇒ refusal names ${c.capability}`, out.data.result.includes(`does not support ${c.label} (capability ${c.capability} not advertised)`) && out.data.outcome === 'no-change', `${out.data.outcome}: ${out.data.result}`)
  }
  await call({ op: 'disconnect', session: 'bare' })
}

section('(3) tool surface — read-only matrix, permissions, validateInput')
{
  for (const op of ['dataBreakpoints', 'instructionBreakpoints', 'writeMemory']) {
    check(`${op} is NOT read-only`, DebugTool.isReadOnly({ op } as never) === false)
    const perm = await DebugTool.checkPermissions({ op } as never, {} as never)
    check(`${op} rides the permitted session`, perm.behavior === 'allow')
  }
  const noSet = await DebugTool.validateInput?.({ op: 'dataBreakpoints' } as never, {} as never)
  check('validateInput: dataBreakpoints without the set fails', noSet?.result === false, JSON.stringify(noSet))
  const noRefs = await DebugTool.validateInput?.({ op: 'instructionBreakpoints' } as never, {} as never)
  check('validateInput: instructionBreakpoints without the set fails', noRefs?.result === false, JSON.stringify(noRefs))
  const noData = await DebugTool.validateInput?.({ op: 'writeMemory', memoryReference: '0x2000' } as never, {} as never)
  check('validateInput: writeMemory without data fails', noData?.result === false, JSON.stringify(noData))
  const noRef = await DebugTool.validateInput?.({ op: 'writeMemory', data: 'AA==' } as never, {} as never)
  check('validateInput: writeMemory without memoryReference fails', noRef?.result === false, JSON.stringify(noRef))
  const emptyOk = await DebugTool.validateInput?.({ op: 'dataBreakpoints', dataBreakpoints: [] } as never, {} as never)
  check('validateInput: an empty set is the clear gesture', emptyOk?.result === true, JSON.stringify(emptyOk))
  const noSession = await call({ op: 'writeMemory', session: 'nope', memoryReference: '0x2000', data: 'AA==' })
  check('a missing session answers typed', noSession.data.outcome === 'failed' && /no debug session 'nope'/.test(noSession.data.result), noSession.data.result)
  check('no leaked sessions', dap._dapSessionCountForTesting() === 0, String(dap._dapSessionCountForTesting()))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ALL DATA-BREAKPOINT CHECKS PASS')
  process.exit(0)
}
console.log(` ${failures} CHECK(S) FAILED`)
process.exit(1)
