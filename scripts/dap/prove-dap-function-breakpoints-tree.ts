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
function clearKnobs(): void {
  for (const knob of ['MOCK_MULTI_CHILDREN', 'MOCK_MULTI_PARENT_LINGERS', 'MOCK_MULTI_RUNINTERMINAL', 'MOCK_MULTI_UNKNOWN_REVERSE', 'MOCK_MULTI_GRANDCHILD', 'MOCK_MULTI_CHILD_SILENT', 'MOCK_MULTI_LAZY_VERIFY', 'MOCK_MULTI_ROOT_HOSTS', 'MOCK_MULTI_NO_CONDITIONS']) {
    delete process.env[knob]
  }
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — function-breakpoints-tree proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type Call = { data: { result: string; outcome: string; debuggee?: string }; effect: { details?: Record<string, unknown> } }

async function main(): Promise<void> {
  const MULTI = join(import.meta.dir, 'mock-dap-adapter-multi.mjs')
  const SINGLE = join(import.meta.dir, 'mock-dap-adapter.mjs')
  const FILE = '/tmp/demo.js'
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mockmulti: { command: process.execPath, args: [MULTI, '${port}', '127.0.0.1'], connect: 'tcp' },
    mockmultiStdio: { command: process.execPath, args: [MULTI] },
    mock: { command: process.execPath, args: [SINGLE] },
  })
  delete process.env.MERCURY_DAP
  clearKnobs()

  const { getDapSession, _dapSessionCountForTesting } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
  const { getDebugToolDescription } = await import(join(SRC, 'tools/DebugTool/prompt.ts'))
  const { processMainOwner } = await import(join(SRC, 'services/run/resolveOwner.ts'))
  const owner = processMainOwner()
  const call = async (input: Record<string, unknown>): Promise<Call> =>
    (await DebugTool.call(input as never, { owner } as never)) as Call
  const ring = (session = 'main'): string[] => (getDapSession(owner, session)?.output ?? []) as string[]
  const lastRound = (who: string, session = 'main'): string | undefined =>
    [...ring(session)].reverse().find(l => l.includes(`[mock] ${who} setFunctionBreakpoints `))
  const CONDITIONAL = JSON.stringify([{ name: 'compute', condition: 'x > 1' }, { name: 'helper' }])

  console.log('============================================================')
  console.log(' Debug tool: conditional function breakpoints, tree-wide — proof')
  console.log('============================================================')

  section('S  the schema: names, or {name, condition?, hitCondition?} rows')
  {
    const schema = DebugTool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    check('plain names are accepted', schema.safeParse({ op: 'functionBreakpoints', functions: ['compute', 'helper'] }).success === true)
    check('a conditional row is accepted', schema.safeParse({ op: 'functionBreakpoints', functions: [{ name: 'compute', condition: 'x > 1' }] }).success === true)
    check('a hit-count row is accepted', schema.safeParse({ op: 'functionBreakpoints', functions: [{ name: 'compute', hitCondition: '3' }] }).success === true)
    check('names and rows mix', schema.safeParse({ op: 'functionBreakpoints', functions: ['helper', { name: 'compute', condition: 'x > 1' }] }).success === true)
    check('a row without a name is refused', schema.safeParse({ op: 'functionBreakpoints', functions: [{ condition: 'x > 1' }] }).success === false)
    check('a row with a logMessage is refused (function breakpoints carry none)', schema.safeParse({ op: 'functionBreakpoints', functions: [{ name: 'compute', logMessage: 'hit' }] }).success === false)
  }

  section('F1 a conditional function breakpoint reaches every tree member')
  {
    const launch = await call({ op: 'launch', adapter: 'mockmulti', program: FILE, file: FILE, lines: [3] })
    check('launch stops in the child', /stopped in 'child-1' — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
    const set = await call({ op: 'functionBreakpoints', functions: [{ name: 'compute', condition: 'x > 1' }, 'helper'] })
    check('the op succeeds naming the condition and the verifier', set.data.outcome === 'succeeded' && /compute if x > 1: verified by child-1/.test(set.data.result) && /helper: verified by child-1/.test(set.data.result), `${set.data.outcome}: ${set.data.result}`)
    check('the effect details carry the merged rows', JSON.stringify((set.effect.details?.functionBreakpoints as Array<{ name: string; verified: boolean; verifier?: string }> | undefined)?.map(r => [r.name, r.verified, r.verifier])) === JSON.stringify([['compute', true, 'child-1'], ['helper', true, 'child-1']]), JSON.stringify(set.effect.details))
    check('the existing child received the rows with the condition', lastRound('child target-1')?.endsWith(CONDITIONAL) === true, lastRound('child target-1') ?? '(no round)')
    check('the parent received the same rows', lastRound('parent')?.endsWith(CONDITIONAL) === true, lastRound('parent') ?? '(no round)')
    const status = await call({ op: 'status' })
    check('status names the function breakpoints', /function breakpoints: compute,helper/.test(status.data.result), status.data.result)

    section('F2 a child started afterwards receives the same set')
    const late = await call({ op: 'customRequest', method: 'mock/spawnChild', body: JSON.stringify({ name: 'child-late', id: 'target-late' }) })
    check('mock/spawnChild answered', late.data.outcome === 'succeeded', late.data.result.slice(0, 120))
    check('the late child came up', await waitFor(() => ring().some(l => l.includes('[mock] child target-late up'))), ring().join(' | '))
    check('…and received the rows with the condition before its launch finished', lastRound('child target-late')?.endsWith(CONDITIONAL) === true && ring().findIndex(l => l.includes('child target-late setFunctionBreakpoints')) < ring().findIndex(l => l.includes('[mock] child target-late up')), lastRound('child target-late') ?? '(no round)')
    const lateStopped = (): boolean =>
      (getDapSession(owner, 'main')?.treeSessions() as Array<{ label: string; lastStopped: unknown }> | undefined)?.some(s => s.label === 'child-late' && s.lastStopped !== null) === true
    check('the late child stopped on the inherited source breakpoint (it stays live for the clear)', await waitFor(lateStopped))

    section('F3 functions: [] clears the set on every member')
    const cleared = await call({ op: 'functionBreakpoints', functions: [] })
    check('the clear succeeds and says so', cleared.data.outcome === 'succeeded' && /function breakpoints cleared on every session of the tree/.test(cleared.data.result), `${cleared.data.outcome}: ${cleared.data.result}`)
    check("the existing child's LAST round carried none", lastRound('child target-1')?.endsWith(' []') === true, lastRound('child target-1') ?? '(no round)')
    check("the late child's LAST round carried none", lastRound('child target-late')?.endsWith(' []') === true, lastRound('child target-late') ?? '(no round)')
    check("the parent's LAST round carried none", lastRound('parent')?.endsWith(' []') === true, lastRound('parent') ?? '(no round)')
    const statusCleared = await call({ op: 'status' })
    check('status no longer names function breakpoints', !/function breakpoints:/.test(statusCleared.data.result), statusCleared.data.result)

    section('F4 a child started after the clear receives no function breakpoints at all')
    const after = await call({ op: 'customRequest', method: 'mock/spawnChild', body: JSON.stringify({ name: 'child-after', id: 'target-after' }) })
    check('mock/spawnChild answered', after.data.outcome === 'succeeded', after.data.result.slice(0, 120))
    check('the child came up', await waitFor(() => ring().some(l => l.includes('[mock] child target-after up'))), ring().join(' | '))
    check('it received NO setFunctionBreakpoints', lastRound('child target-after') === undefined, lastRound('child target-after') ?? '')
    check('…while it still received the source breakpoint', ring().some(l => l.includes(`[mock] child target-after setBreakpoints ${FILE} lines=[3]`)), ring().join(' | '))

    const disc = await call({ op: 'disconnect' })
    check('disconnect reaps the tree', /disconnected/.test(disc.data.result), disc.data.result)
  }

  section('F5 the stdio shape (a fresh adapter process per child) carries the set too')
  {
    const launch = await call({ op: 'launch', adapter: 'mockmultiStdio', program: FILE, file: FILE, lines: [3], session: 'stdio' })
    check('stdio launch stops in the child', /stopped in 'child-1' — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
    const set = await call({ op: 'functionBreakpoints', functions: [{ name: 'compute', hitCondition: '2' }], session: 'stdio' })
    check('a hit-count row is verified by the child', /compute hits 2: verified by child-1/.test(set.data.result), set.data.result)
    check('the stdio child received the hit count', lastRound('child target-1', 'stdio')?.endsWith(JSON.stringify([{ name: 'compute', hitCondition: '2' }])) === true, lastRound('child target-1', 'stdio') ?? '(no round)')
    await call({ op: 'disconnect', session: 'stdio' })
  }

  section('G  the gates: precise refusals before anything is sent')
  {
    await call({ op: 'launch', adapter: 'mock', program: '/tmp/demo.py', file: '/tmp/demo.py', lines: [3], session: 'nofn' })
    const unsupported = await call({ op: 'functionBreakpoints', functions: ['compute'], session: 'nofn' })
    check('an adapter without supportsFunctionBreakpoints refuses naming the capability', unsupported.data.outcome === 'no-change' && /supportsFunctionBreakpoints not advertised/.test(unsupported.data.result), `${unsupported.data.outcome}: ${unsupported.data.result}`)
    await call({ op: 'disconnect', session: 'nofn' })

    process.env.MOCK_MULTI_NO_CONDITIONS = '1'
    await call({ op: 'launch', adapter: 'mockmulti', program: FILE, file: FILE, lines: [3], session: 'nocond' })
    const cond = await call({ op: 'functionBreakpoints', functions: [{ name: 'compute', condition: 'x > 1' }], session: 'nocond' })
    check('a condition on an adapter without supportsConditionalBreakpoints refuses precisely', cond.data.outcome === 'no-change' && /does not support conditional breakpoints \(capability supportsConditionalBreakpoints not advertised/.test(cond.data.result), `${cond.data.outcome}: ${cond.data.result}`)
    const hits = await call({ op: 'functionBreakpoints', functions: [{ name: 'compute', hitCondition: '3' }], session: 'nocond' })
    check('a hit count on an adapter without supportsHitConditionalBreakpoints refuses precisely', hits.data.outcome === 'no-change' && /does not support hit-count breakpoints \(capability supportsHitConditionalBreakpoints not advertised/.test(hits.data.result), `${hits.data.outcome}: ${hits.data.result}`)
    check('nothing reached the adapter for the refused calls', lastRound('child target-1', 'nocond') === undefined && lastRound('parent', 'nocond') === undefined, ring('nocond').join(' | '))
    const plain = await call({ op: 'functionBreakpoints', functions: ['compute'], session: 'nocond' })
    check('a plain name never gates on conditions', plain.data.outcome === 'succeeded' && /compute: verified by child-1/.test(plain.data.result), `${plain.data.outcome}: ${plain.data.result}`)
    await call({ op: 'disconnect', session: 'nocond' })
    clearKnobs()

    const omitted = await DebugTool.validateInput?.({ op: 'functionBreakpoints' } as never, {} as never)
    check('validateInput still refuses a missing functions field', omitted?.result === false, JSON.stringify(omitted))
  }

  section('D  the description says it in one sentence')
  {
    const text = getDebugToolDescription(false)
    check('…the rows and their gates', /functions also takes \{name, condition\?, hitCondition\?\} rows \(condition and hit count capability-gated\)/.test(text))
    check('…every session and a later child; [] clears everywhere', /the set reaches every session of the tree and a child session started later, and functions: \[\] clears it everywhere/.test(text))
  }

  check('no sessions leak', _dapSessionCountForTesting() === 0, String(_dapSessionCountForTesting()))

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL FUNCTION-BREAKPOINT TREE PROOFS PASS')
  process.exit(0)
}

void main()
