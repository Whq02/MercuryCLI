#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
async function waitFor(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(res => setTimeout(res, 20))
  }
  return cond()
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — clear-last-breakpoint proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter-multi.mjs')
  const FILE = '/tmp/demo.js'
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mockmulti: { command: process.execPath, args: [MOCK, '${port}', '127.0.0.1'], connect: 'tcp' },
  })
  delete process.env.MERCURY_DAP
  for (const knob of ['MOCK_MULTI_CHILDREN', 'MOCK_MULTI_PARENT_LINGERS', 'MOCK_MULTI_RUNINTERMINAL', 'MOCK_MULTI_UNKNOWN_REVERSE', 'MOCK_MULTI_GRANDCHILD', 'MOCK_MULTI_CHILD_SILENT', 'MOCK_MULTI_LAZY_VERIFY', 'MOCK_MULTI_ROOT_HOSTS']) {
    delete process.env[knob]
  }

  const { getDapSession, _dapSessionCountForTesting } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
  const { dropEmptyOptionalArgs } = await import(join(SRC, 'services/providers/toolCallGate.ts'))
  const { processMainOwner } = await import(join(SRC, 'services/run/resolveOwner.ts'))
  const owner = processMainOwner()
  const call = async (input: Record<string, unknown>): Promise<{ result: string; outcome: string; debuggee?: string }> =>
    ((await DebugTool.call(input as never, { owner } as never)) as { data: { result: string; outcome: string; debuggee?: string } }).data
  const ring = (): string[] => (getDapSession(owner, 'main')?.output ?? []) as string[]
  const lastRound = (who: string): string | undefined =>
    [...ring()].reverse().find(l => l.includes(`[mock] ${who} setBreakpoints ${FILE} `))

  console.log('============================================================')
  console.log(' Debug tool: clearing the last breakpoint of a file — proof')
  console.log('============================================================')

  section('G  the provider gate keeps an explicit empty set')
  {
    const keptLines = dropEmptyOptionalArgs({ op: 'breakpoints', file: FILE, lines: [] }, DebugTool)
    check('lines: [] survives dropEmptyOptionalArgs', Array.isArray(keptLines.lines), JSON.stringify(keptLines))
    const keptRich = dropEmptyOptionalArgs({ op: 'breakpoints', file: FILE, breakpoints: [] }, DebugTool)
    check('breakpoints: [] survives dropEmptyOptionalArgs', Array.isArray(keptRich.breakpoints), JSON.stringify(keptRich))
  }

  section('C1 set two, clear with lines: [] — the report and the wire')
  {
    const launch = await call({ op: 'launch', adapter: 'mockmulti', program: FILE, file: FILE, lines: [3] })
    check('launch stops in the child on line 3', /stopped in 'child-1' — reason breakpoint/.test(launch.result), launch.result.split('\n')[0])
    const two = await call({ op: 'breakpoints', file: FILE, lines: [3, 9] })
    check('two breakpoints set, verified by the child', two.outcome === 'succeeded' && /line 3: verified by child-1/.test(two.result) && /line 9: verified by child-1/.test(two.result), two.result)

    section('C3a control: a child started BEFORE the clear inherits the set')
    const early = await call({ op: 'customRequest', method: 'mock/spawnChild', body: JSON.stringify({ name: 'child-early', id: 'target-early' }) })
    check('mock/spawnChild answered', early.outcome === 'succeeded', early.result.slice(0, 120))
    check('the early child came up', await waitFor(() => ring().some(l => l.includes('[mock] child target-early up'))), ring().join(' | '))
    check('…and received the current set for the file', lastRound('child target-early')?.includes('lines=[3,9]') === true, lastRound('child target-early') ?? '(no round)')

    section('C1 (continued) the clear')
    const cleared = await call({ op: 'breakpoints', file: FILE, lines: [] })
    check('lines: [] succeeds and reports 0 breakpoints', cleared.outcome === 'succeeded' && /0 breakpoints/.test(cleared.result), `${cleared.outcome}: ${cleared.result}`)
    check("the child's LAST setBreakpoints for the file carried none", lastRound('child target-1')?.includes('lines=[]') === true, lastRound('child target-1') ?? '(no round)')
    check("the early child's LAST round carried none too", lastRound('child target-early')?.includes('lines=[]') === true, lastRound('child target-early') ?? '(no round)')
    check("the parent's LAST round carried none", lastRound('parent')?.includes('lines=[]') === true, lastRound('parent') ?? '(no round)')

    section('C2 status shows no breakpoints for the file')
    const status = await call({ op: 'status' })
    check('status carries no breakpoints line after the clear', !/breakpoints:/.test(status.result), status.result)

    section('C3b a child started AFTER the clear receives no breakpoints for the file')
    const late = await call({ op: 'customRequest', method: 'mock/spawnChild', body: JSON.stringify({ name: 'child-late', id: 'target-late' }) })
    check('mock/spawnChild answered again', late.outcome === 'succeeded', late.result.slice(0, 120))
    check('the late child came up', await waitFor(() => ring().some(l => l.includes('[mock] child target-late up'))), ring().join(' | '))
    check('the late child received NO setBreakpoints for the file', lastRound('child target-late') === undefined, lastRound('child target-late') ?? '')
    const statusLate = await call({ op: 'status' })
    check('status still carries no breakpoints line', /child 'child-late'/.test(statusLate.result) && !/breakpoints:/.test(statusLate.result), statusLate.result)

    section('C4 the rich form clears the same way')
    const rich = await call({ op: 'breakpoints', file: FILE, breakpoints: [{ line: 3 }] })
    check('a rich breakpoint set again, verified by the child', /line 3: verified by child-1/.test(rich.result), rich.result)
    const richCleared = await call({ op: 'breakpoints', file: FILE, breakpoints: [] })
    check('breakpoints: [] succeeds and reports 0 breakpoints', richCleared.outcome === 'succeeded' && /0 breakpoints/.test(richCleared.result), `${richCleared.outcome}: ${richCleared.result}`)
    check("the child's LAST round carried none", lastRound('child target-1')?.includes('lines=[]') === true, lastRound('child target-1') ?? '(no round)')

    section('C5 omitting both still refuses with the usage words')
    const omitted = await call({ op: 'breakpoints', file: FILE })
    check('no lines and no breakpoints ⇒ the usage refusal', omitted.outcome === 'failed' && /breakpoints needs file \+ lines \(or the rich breakpoints array\)/.test(omitted.result), `${omitted.outcome}: ${omitted.result}`)
    const validEmpty = await DebugTool.validateInput?.({ op: 'breakpoints', file: FILE, lines: [] } as never, {} as never)
    check('validateInput accepts lines: []', validEmpty?.result === true, JSON.stringify(validEmpty))
    const validRichEmpty = await DebugTool.validateInput?.({ op: 'breakpoints', file: FILE, breakpoints: [] } as never, {} as never)
    check('validateInput accepts breakpoints: []', validRichEmpty?.result === true, JSON.stringify(validRichEmpty))
    const invalid = await DebugTool.validateInput?.({ op: 'breakpoints', file: FILE } as never, {} as never)
    check('validateInput refuses the omission', invalid?.result === false, JSON.stringify(invalid))

    const disc = await call({ op: 'disconnect' })
    check('disconnect reaps the tree', /disconnected/.test(disc.result), disc.result)
  }

  section('L  lines: [] at launch is a plain launch')
  {
    const t0 = Date.now()
    const launch = await call({ op: 'launch', adapter: 'mockmulti', program: FILE, file: FILE, lines: [], session: 'plain' })
    const took = Date.now() - t0
    check('the launch neither waits for a first stop nor sends a set', launch.outcome === 'succeeded' && /running — op:"output"/.test(launch.result) && took < 8_000, `${took}ms: ${launch.result.split('\n')[0]}`)
    await call({ op: 'disconnect', session: 'plain' })
  }

  check('no sessions leak', _dapSessionCountForTesting() === 0, String(_dapSessionCountForTesting()))

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL CLEAR-LAST-BREAKPOINT PROOFS PASS')
  process.exit(0)
}

void main()
